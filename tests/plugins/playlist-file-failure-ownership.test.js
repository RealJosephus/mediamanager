import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { PlaylistFileWriter, preparePlaylistFile, serializePlaylistFile } from '../../src/library/playlist-file.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { openConfiguredPluginHost } from './configuration-host.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres', 'webdav'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const cleanupError = () => Object.assign(new Error('The actual file close completed with a failed reply.'), { code: 'EIO', status: 503 });

// Evidence must not execute the hostile diagnostic getters under examination.
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    result[key] = !Object.hasOwn(descriptor, 'value') ? { accessor: true }
      : key === 'errors' ? descriptor.value.map(observation)
        : key === 'cause' ? observation(descriptor.value) : descriptor.value;
  }
  return result;
}

async function emptyRelations(database, links) {
  const counts = {};
  for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins],
    ['states', `"${links.schemaName}".item_states`], ['cohorts', `"${links.schemaName}".item_cohorts`]]) {
    counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  }
  assert.deepEqual(counts, { sets: 0, rows: 0, pins: 0, states: 0, cohorts: 0 });
  return counts;
}

test('Playlist failures retain actual PostgreSQL causes and drain Local spool owners before recovery', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-file-failure-ownership-'));
  const localRoot = path.join(root, 'local'), spool = path.join(localRoot, 'spool'), identityRoot = path.join(root, 'identity');
  await fs.mkdir(spool, { recursive: true });
  const spoolRoot = path.join(identityRoot, 'spool'), playlist = path.join(identityRoot, 'mix.m3u');
  const backgroundErrors = []; let host, storage, database, links;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    if (database) database.queryHook = null;
    await attempt(() => storage?.close()); await attempt(() => host?.close()); await attempt(() => links?.close());
    if (database) await attempt(() => dropPostgresTestDatabase(database));
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ failures: failures.map(observation), backgroundErrors }, null, 2) + '\n');
    assert.deepEqual(failures, []); assert.deepEqual(backgroundErrors, []);
  });
  database = await createPostgresTestDatabase(null, 'playlist_failure');
  links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  host = await openConfiguredPluginHost({ directory: path.join(root, 'host'), onError: error => backgroundErrors.push(observation(error)) });
  storage = await createConfiguredStorage(undefined, { plugins: host });
  const definition = storage.configuration();
  definition.instances.push({ id: 'owned-local', type: 'local', config: { root: localRoot, writable: true } });
  definition.mounts.push({ path: '/owned-local', instanceId: 'owned-local', capabilities });
  definition.prefixes.push({ identityRoot, accessRoot: '/owned-local', style: process.platform === 'win32' ? 'windows' : 'posix',
    purpose: 'application', returnAccess: 'The failure regression owns this actual Local spool.' });
  await storage.configure(definition);
  const samples = [
    { name: 'actual-sql-and-nonempty-remove', primary: 'sql', removeFault: { blocked: true } },
    { name: 'actual-sql-and-close', primary: 'sql', closeFault: { reason: cleanupError() } },
    ...['message', 'code', 'status', 'statusCode'].map(property => ({ name: `sql-getter-${property}`, primary: 'sql', property, closeFault: { reason: false } })),
    ...falsy.map(([name, reason]) => ({ name: `primary-${name}-and-close`, primary: 'falsy', reason, closeFault: { reason: cleanupError() } })),
    ...falsy.map(([name, reason]) => ({ name: `sql-and-close-${name}`, primary: 'sql', closeFault: { reason } })),
    ...falsy.map(([name, reason]) => ({ name: `single-primary-${name}`, primary: 'falsy', reason })),
    ...falsy.map(([name, reason]) => ({ name: `single-remove-${name}`, primary: 'none', removeFault: { reason } })),
    { name: 'sql-and-every-release', primary: 'sql', closeFault: { reason: false }, removeFault: { reason: null }, ownerFault: { reason: undefined } },
  ];
  const retain = storage.fileSystem.retainDirectory;
  let current, retained = 0;
  storage.fileSystem.retainDirectory = (...args) => {
    const owner = retain(...args); retained++;
    const record = current;
    if (!record) return owner;
    const open = owner.fileSystem.open.bind(owner.fileSystem), remove = owner.fileSystem.rm.bind(owner.fileSystem), closeOwner = owner.close.bind(owner);
    const owned = { close: closeOwner, closed: false }; record.owners.push(owned);
    owner.fileSystem.open = async (...values) => {
      const file = await open(...values), close = file.close.bind(file);
      record.files.push(file); let closing;
      return new Proxy(file, { get(target, key) {
        if (key === 'close') return () => closing ??= Promise.resolve().then(async () => {
          await close(); record.fileCloses++;
          if (record.selected && record.sample.closeFault) {
            const reason = record.sample.closeFault.reason; record.failures.push(reason); throw reason;
          }
        });
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    owner.fileSystem.rm = async (identity, options) => {
      const actual = path.join(spool, path.basename(identity));
      assert.equal(path.dirname(actual), spool);
      record.spoolBytes.push((await fs.readFile(actual)).toString('base64'));
      if (record.selected && record.sample.removeFault?.blocked) {
        // The real Local rmdir must reject a real nonempty directory. Preserve
        // the exact private spool name, then remove this blocker in teardown.
        await fs.unlink(actual); await fs.mkdir(actual); await fs.writeFile(path.join(actual, 'owned-blocker'), 'retain until observed');
        record.blocker = actual;
      }
      try {
        await remove(identity, options); record.removals++;
        if (record.selected && record.sample.removeFault && !record.sample.removeFault.blocked) throw record.sample.removeFault.reason;
      } catch (error) { record.failures.push(error); throw error; }
    };
    let closing;
    owner.close = () => closing ??= Promise.resolve().then(async () => {
      await closeOwner(); owned.closed = true;
      if (record.selected && record.sample.ownerFault) {
        const reason = record.sample.ownerFault.reason; record.failures.push(reason); throw reason;
      }
    });
    return owner;
  };
  for (const sample of samples) await t.test(sample.name, async t => {
    const record = { sample, selected: true, files: [], owners: [], failures: [], fileCloses: 0, removals: 0, spoolBytes: [] };
    current = record;
    let cohort, prepared, closedPrepared = false, result, primary, injected = false, countQueries = 0;
    const cleanupErrors = [];
    t.after(async () => {
      record.selected = false; current = undefined; database.queryHook = null;
      const attempt = async operation => { try { await operation(); } catch (error) { cleanupErrors.push(observation(error)); } };
      if (prepared && !closedPrepared) await attempt(() => prepared.close());
      for (const file of record.files) await attempt(() => file.close());
      for (const owner of record.owners) if (!owner.closed) await attempt(owner.close);
      await attempt(() => cohort?.release()); await attempt(() => links.flushOwnedReleases()); await attempt(() => links.flushReleases());
      if (record.blocker) { assert.equal(path.dirname(record.blocker), spool); await attempt(() => fs.rm(record.blocker, { recursive: true, force: true })); }
      await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ primary: observation(primary), result: observation(result?.error),
        cleanup: record.failures.map(observation), countQueries, sqlCode: record.sqlCode, filesClosed: record.files.map(file => file.fd), ownersClosed: record.owners.map(owner => owner.closed),
        spoolBytes: record.spoolBytes, observations: record.observations, cleanupErrors }, null, 2) + '\n');
      assert.deepEqual(cleanupErrors, []);
    });
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
    Object.assign(item, { Id: '53800000-0000-0000-0000-000000000001', Path: path.join(identityRoot, 'song.mp3'), Name: 'Actual duplicate', RunTimeTicks: 30000000n });
    cohort = await createNativeItemCohort({ linkedChildren: links });
    await cohort.capture(item, { ordinal: 1n }); await cohort.capture(item, { ordinal: 2n });
    const expected = serializePlaylistFile(playlist, [item, item]);
    const countSql = `SELECT count(*) AS count FROM ${cohort.entry.rows} WHERE view_id=$1`;
    database.queryHook = async function (statement, ...args) {
      const sql = typeof statement === 'string' ? statement : statement.text;
      if (record.selected && !injected && sql === countSql) {
        injected = true; countQueries++;
        if (sample.primary === 'sql') {
          try { return await this.query(`SELECT missing_playlist_count FROM ${cohort.entry.rows} WHERE view_id=$1`, ...args); }
          catch (error) {
            record.sqlCode = error.code;
            primary = Object.assign(error, { status: 409, statusCode: 503 });
            if (sample.property) Object.defineProperty(primary, sample.property, { get() { throw new Error('A diagnostic getter must not replace the SQL failure.'); } });
            throw primary;
          }
        }
        const value = await this.query(statement, ...args);
        if (sample.primary === 'falsy') { primary = sample.reason; throw primary; }
        return value;
      }
      return this.query(statement, ...args);
    };
    result = await outcome(preparePlaylistFile(playlist, cohort, { fileSystem: storage.fileSystem, spoolRoot }));
    if (Object.hasOwn(result, 'value')) prepared = result.value;
    if (sample.primary === 'none' && prepared) { result = await outcome(prepared.close()); closedPrepared = true; }
    record.selected = false; database.queryHook = null;
    assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(countQueries, 1);
    if (sample.primary === 'sql') assert.equal(record.sqlCode, '42703');
    assert.equal(record.failures.length, [sample.closeFault, sample.removeFault, sample.ownerFault].filter(Boolean).length);
    const reasons = sample.primary === 'none' ? record.failures : [primary, ...record.failures];
    if (reasons.length === 1) assert.equal(result.error, reasons[0]);
    else {
      assert.equal(result.error.cause, primary); assert.equal(result.error.errors.length, reasons.length);
      for (const [index, reason] of reasons.entries()) assert.equal(result.error.errors[index], reason);
      if (sample.primary === 'sql') {
        for (const [key, value] of Object.entries({ code: '42703', status: 409, statusCode: 503 })) {
          if (sample.property === key) assert.equal(Object.hasOwn(result.error, key), false);
          else assert.equal(result.error[key], value);
        }
        if (sample.property === 'message') assert.equal(result.error.message, 'Playlist file resources failed to release.');
      }
    }
    assert.equal(record.files.length, 1); assert.equal(record.fileCloses, 1); assert.equal(record.files[0].fd, -1);
    assert.equal(record.owners.length, 1); assert.equal(record.owners[0].closed, true);
    assert.equal(record.spoolBytes[0], sample.primary === 'none' ? expected.toString('base64') : '');
    if (record.blocker) {
      assert.equal(record.failures[0].code, 'ENOTEMPTY'); assert.equal(record.failures[0].cause.code, 'not-empty');
      assert.equal(record.failures[0].cause.cause.code, 'ENOTEMPTY');
      assert.deepEqual(await fs.readdir(spool), [path.basename(record.blocker)]);
      assert.equal(path.dirname(record.blocker), spool); await fs.rm(record.blocker, { recursive: true }); record.blocker = undefined;
    }
    assert.deepEqual(await fs.readdir(spool), []);
    const recovery = await preparePlaylistFile(playlist, cohort, { fileSystem: storage.fileSystem, spoolRoot });
    try {
      const bytes = []; for await (const part of recovery.stream()) bytes.push(part);
      assert.deepEqual(Buffer.concat(bytes), expected);
    } finally { await recovery.close(); }
    assert.deepEqual(await fs.readdir(spool), []); assert.ok(record.files.every(file => file.fd === -1)); assert.ok(record.owners.every(owner => owner.closed));
    await cohort.release(); cohort = undefined; await links.flushOwnedReleases(); await links.flushReleases();
    record.observations = { recoveryBytes: expected.toString('base64'), counts: await emptyRelations(database, links) };
  });
  current = undefined;
  await t.test('Local preflight preserves falsy and diagnostic rejections after actual stat', async t => {
    const filename = path.join(localRoot, 'mix.m3u'), original = Buffer.from('Existing local playlist bytes.');
    await fs.writeFile(filename, original);
    const item = { Type: 'Playlist', Path: playlist, Id: '53800000-0000-0000-0000-000000000002' };
    const writer = new PlaylistFileWriter({ vfs: storage.vfs, identityMap: storage.identityMap, fileSystem: storage.fileSystem, spoolRoot });
    const stat = storage.vfs.stat, before = retained, observations = [];
    t.after(async () => {
      storage.vfs.stat = stat;
      await fs.writeFile(path.join(root, 'local-preflight.json'), JSON.stringify(observations, null, 2) + '\n');
    });
    for (const [name, reason] of falsy) await t.test(name, async () => {
      let actualStats = 0;
      storage.vfs.stat = async (...args) => { const value = await stat(...args); actualStats++; assert.equal(value.kind, 'file'); throw reason; };
      const result = await outcome(writer.prepare(item));
      observations.push({ name, actualStats, rejected: Object.hasOwn(result, 'error'), reason: observation(result.error) });
      assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(result.error, reason); assert.equal(actualStats, 1);
    });
    for (const variant of ['getter-code', 'getter-errors', 'aggregate-code', 'aggregate-no-code']) await t.test(variant, async () => {
      let primary, rejection;
      storage.vfs.stat = async (...args) => {
        try { return await stat(...args); }
        catch (error) {
          assert.equal(error.code, 'not-found'); assert.equal(error.cause.code, 'ENOENT'); primary = error;
          if (variant.startsWith('getter')) {
            Object.defineProperty(error, variant.slice(7), { get() { throw new Error('The preflight diagnostic getter failed.'); } });
            rejection = error;
          } else {
            rejection = new AggregateError([error, cleanupError()], 'Actual absence and failed completion', { cause: error });
            if (variant === 'aggregate-code') rejection.code = 'not-found';
          }
          throw rejection;
        }
      };
      const result = await outcome(writer.prepare({ ...item, Path: path.join(identityRoot, variant + '.m3u') }));
      observations.push({ name: variant, rejected: Object.hasOwn(result, 'error'), reason: observation(result.error) });
      assert.ok(primary); assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(result.error, rejection);
    });
    storage.vfs.stat = stat;
    assert.deepEqual(await writer.prepare(item), { accessPath: '/owned-local/mix.m3u', identityPath: playlist });
    const missing = path.join(identityRoot, 'new.m3u');
    assert.deepEqual(await writer.prepare({ ...item, Path: missing }), { accessPath: '/owned-local/new.m3u', identityPath: missing });
    assert.deepEqual(await fs.readFile(filename), original); assert.deepEqual(await fs.readdir(spool), []); assert.equal(retained, before);
  });
});

test('Playlist preflight rejects actual WebDAV absence combined with response cleanup failure', {
  skip: !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-preflight-webdav-'));
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  for (const [name, reason] of falsy) await t.test(name, async t => {
    const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    const requests = []; let selected = true, canceled = 0, drained = 0, statFailure, operation, expectedCleanup;
    const adapter = new WebDavAdapter({ baseUrl: service.baseUrl, credentialRef: 'OWNED_WEBDAV', capabilities }, {
      resolveCredential: () => service.authorization,
      async fetch(url, options) {
        const response = await fetch(url, options);
        requests.push({ method: options.method, path: new URL(url).pathname, status: response.status });
        if (!selected || options.method !== 'PROPFIND' || response.status !== 404) return response;
        const body = response.body, cancel = body.cancel.bind(body);
        const ownedBody = new Proxy(body, { get(target, key) {
          if (key === 'cancel') return async (...args) => {
            await cancel(...args); canceled++;
            const reader = body.getReader();
            try { assert.equal((await reader.read()).done, true); drained++; } finally { reader.releaseLock(); }
            throw reason;
          };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        return new Proxy(response, { get(target, key) {
          if (key === 'body') return ownedBody;
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    const stat = adapter.stat.bind(adapter);
    adapter.stat = async (...args) => { try { return await stat(...args); } catch (error) { if (selected) statFailure = error; throw error; } };
    t.after(async () => {
      selected = false; await operation;
      const closing = await outcome(registry.close());
      await fs.writeFile(path.join(root, name + '.json'), JSON.stringify({ requests, canceled, drained, statFailure: observation(statFailure),
        expectedCleanup: observation(expectedCleanup), close: observation(closing.error) }, null, 2) + '\n');
      if (expectedCleanup) { assert.equal(closing.error.errors.length, 1); assert.equal(closing.error.errors[0], expectedCleanup); }
      else if (Object.hasOwn(closing, 'error')) throw closing.error;
    });
    registry.registerType('actual-webdav', async () => adapter);
    await registry.createInstance('remote', 'actual-webdav', {});
    vfs.mount({ path: '/remote', instanceId: 'remote', capabilities });
    const identityRoot = path.join(root, 'identities');
    identityMap.addPrefix({ identityRoot, accessRoot: '/remote', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'The isolated actual WebDAV target.' });
    const filename = name + '.m3u', item = { Type: 'Playlist', Path: path.join(identityRoot, filename) };
    const writer = new PlaylistFileWriter({ vfs, identityMap });
    operation = outcome(writer.prepare(item)); const result = await operation;
    if (statFailure?.errors) expectedCleanup = statFailure.errors[1];
    selected = false;
    assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(result.error, statFailure);
    assert.equal(statFailure.code, 'not-found'); assert.equal(statFailure.errors.length, 2);
    assert.equal(statFailure.errors[0].code, 'not-found'); assert.equal(statFailure.errors[0].details.status, 404);
    assert.equal(expectedCleanup.cause, reason); assert.equal(canceled, 1); assert.equal(drained, 1);
    assert.deepEqual(requests.map(request => [request.method, request.status]), [['PROPFIND', 404]]);
    await assert.rejects(fs.stat(path.join(service.media, filename)), { code: 'ENOENT' });
    const plan = await writer.prepare(item), bytes = Buffer.from('Recovered after actual absence and response cancellation.');
    assert.deepEqual(plan, { accessPath: '/remote/' + filename, identityPath: item.Path });
    await vfs.write(plan.accessPath, bytes, { overwrite: true, size: BigInt(bytes.length) });
    assert.deepEqual(await fs.readFile(path.join(service.media, filename)), bytes);
    assert.deepEqual(await writer.prepare(item), plan);
    await vfs.delete(plan.accessPath); await assert.rejects(fs.stat(path.join(service.media, filename)), { code: 'ENOENT' });
  });
});
