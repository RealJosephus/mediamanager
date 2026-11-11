import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalXmlPlugin, serializeLocalXml } from '../../src/metadata/local-xml.js';
import { networkXmlSpool } from '../../src/metadata/local-xml-sinks.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres', 'webdav'];
const parentId = '50900000-0000-0000-0000-000000000001';
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];

test('XML saves retain real SQL, frame upload and file cleanup failures without losing partial bytes or owners', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-xml-save-ownership-'));
  const state = path.join(root, 'state'), spoolRoot = path.join(state, 'spool');
  await fs.mkdir(spoolRoot, { recursive: true });
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  const database = await createPostgresTestDatabase(t, 'xml_save_owner');
  const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  const registry = new StorageRegistry(); registry.registerType('local', config => LocalAdapter.open(config));
  registry.registerType('webdav', config => new WebDavAdapter(config, { resolveCredential: async () => service.authorization }));
  await registry.createInstance('state', 'local', { root: state, writable: true });
  await registry.createInstance('remote', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'fixture', capabilities });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({ path: '/state', instanceId: 'state', capabilities });
  vfs.mount({ path: '/remote', instanceId: 'remote', capabilities });
  identityMap.addPrefix({ identityRoot: state, accessRoot: '/state', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual XML save state.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  let active;
  const handles = [], observe = files => {
    const open = files.open.bind(files), unlink = files.unlink.bind(files);
    files.open = async (...args) => {
      const handle = await open(...args); handles.push(handle);
      const write = handle.write.bind(handle), close = handle.close.bind(handle), read = handle.read.bind(handle);
      const observedWrite = async (...values) => {
        const result = await write(...values);
        if (active?.writeFails && !active.wroteFailure) { active.wroteFailure = true; throw 0; }
        return result;
      };
      const observedRead = async (...values) => {
        const result = await read(...values);
        if (active?.readFails && result.bytesRead === 0) throw active.readFailure;
        return result;
      };
      const observedClose = async () => {
        await close();
        if (active?.closeFails && args[1] === 'w') throw '';
        if (active?.readerCloseFails && args[1] === 'r') throw false;
      };
      // Local handles proxy their shared close onto an owned raw FileHandle.
      // Observe the consumer boundary without replacing that raw close method.
      return new Proxy(handle, { get(target, key) {
        if (key === 'write') return observedWrite;
        if (key === 'read') return observedRead;
        if (key === 'close') return observedClose;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    files.unlink = async (...args) => {
      await unlink(...args);
      if (active?.unlinkFails && !active.unlinkedFailure) { active.unlinkedFailure = true; throw null; }
    };
  };
  observe(fileSystem);
  const retain = fileSystem.retainDirectory.bind(fileSystem);
  fileSystem.retainDirectory = (...args) => { const owner = retain(...args); observe(owner.fileSystem); return owner; };
  t.after(async () => {
    active = undefined;
    await links.flushReleases(); await fileSystem.close(); await registry.close(); await links.close();
    assert.ok(handles.every(handle => handle.fd === -1));
    assert.equal(path.dirname(state), root); await fs.rm(state, { recursive: true });
  });
  const counts = async () => {
    const counts = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    return counts;
  };
  const emptyCounts = { sets: 0, rows: 0, pins: 0 };
  const sqlFailure = async () => {
    const result = await outcome(database.client.query('SELECT missing_xml_save_column'));
    assert.equal(result.error?.code, '42703'); return result.error;
  };
  const saver = createLocalXmlPlugin({ fileSystem, vfs, spoolRoot, linkedChildren: links }).providers.find(value => value.id === 'BoxSetXmlSaver');
  const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
  const scenarios = reasons.flatMap(([label, reason]) => ['local', 'webdav', 'serialize'].map(kind => ({ label: kind + '-' + label, kind, reason })))
    .concat([
      { label: 'local-sql-and-close', kind: 'local', sql: true, closeFails: true },
      { label: 'local-sql-finish-and-close', kind: 'local', sql: true, writeFails: true, closeFails: true },
      { label: 'webdav-sql-upload-and-unlink', kind: 'webdav', sql: true, uploadFails: true, unlinkFails: true },
      { label: 'serialize-sql-and-unlink', kind: 'serialize', sql: true, unlinkFails: true },
      { label: 'local-linked-page-and-close', kind: 'local', linked: true },
      { label: 'webdav-upload-and-reader-close', kind: 'webdav', uploadReturn: true, readerCloseFails: true },
    ]);
  for (const scenario of scenarios) await t.test(scenario.label, async t => {
    const directory = path.join(scenario.kind === 'webdav' ? service.media : state, scenario.label);
    await fs.mkdir(directory); const filename = path.join(directory, 'collection.xml');
    const previous = Buffer.from('previous XML belongs to this exact destination'); await fs.writeFile(filename, previous);
    const item = { Id: parentId, Type: 'BoxSet', Name: 'Partial owned XML', Path: directory, DateCreated: '2026-01-01T00:00:00Z' };
    const context = scenario.kind === 'webdav' ? { accessPath: '/remote/' + scenario.label } : { localRoot: state, localPath: directory };
    let primary, prepared, relation, linkedClosed = 0, uploadCount = 0;
    const write = vfs.write.bind(vfs);
    t.after(async () => {
      active = undefined; vfs.write = write;
      if (prepared) await prepared.close(); if (relation) await links.release(relation);
      await links.flushReleases();
    });
    active = { ...scenario };
    context.getPeople = async () => {
      if (scenario.uploadReturn || scenario.linked) return [];
      if (scenario.sql) { primary = await sqlFailure(); if (scenario.uploadFails) Object.freeze(primary); throw primary; }
      await database.client.query('SELECT 1 AS actual_people_boundary'); throw scenario.reason;
    };
    context.prepareLinkedXmlItems = async () => {
      relation = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId });
        await writer.append({ Path: 'Z:\\Media\\one.mkv', Type: 0 }); return writer.finish();
      });
      return { manualCount: 1n, pages: async function* () {
        yield await links.page(relation);
        if (scenario.linked) { primary = await sqlFailure(); throw primary; }
      }, async close() { const owned = relation; relation = undefined; await links.release(owned); linkedClosed++; if (scenario.linked) throw false; } };
    };
    vfs.write = async (destination, stream, options) => {
      uploadCount++;
      if (scenario.uploadReturn) {
        const first = await stream.next(); assert.equal(first.done, false);
        await write(destination, first.value, { ...options, size: BigInt(first.value.length) });
        primary = await sqlFailure(); throw primary;
      }
      const result = await write(destination, stream, options);
      if (scenario.uploadFails) throw undefined;
      return result;
    };
    const failed = await outcome(scenario.kind === 'serialize'
      ? serializeLocalXml(item, { ...context, spoolRoot, fileSystem }).then(value => { prepared = value; return value; })
      : saver.save(item, context));
    assert.ok(Object.hasOwn(failed, 'error'), 'A failed preparation or cleanup cannot report a successful save.');
    const expected = [scenario.sql || scenario.linked || scenario.uploadReturn ? primary : scenario.reason];
    if (scenario.linked || scenario.uploadReturn) expected.push(false);
    if (scenario.writeFails) expected.push(0);
    if (scenario.closeFails) expected.push('');
    if (scenario.uploadFails) expected.push(undefined);
    if (scenario.unlinkFails) expected.push(null);
    assert.deepEqual(flatten(failed.error), expected);
    if (expected.length === 1) assert.equal(failed.error, expected[0]);
    else { assert.equal(failed.error.code, '42703'); assert.equal(flatten(failed.error)[0], primary); }
    if (scenario.uploadFails) {
      assert.equal(Object.hasOwn(failed.error, 'frameCommitError'), true); assert.equal(failed.error.frameCommitError, undefined);
      assert.equal(Object.isFrozen(primary), true); assert.equal(Object.hasOwn(primary, 'frameCommitError'), false);
    }
    const bytes = await fs.readFile(filename);
    if (scenario.kind === 'serialize') assert.deepEqual(bytes, previous);
    else {
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.match(bytes.toString(), /<LocalTitle>Partial owned XML<\/LocalTitle>/u);
      assert.match(bytes.toString(), /<\/Item>$/u);
    }
    assert.equal(uploadCount, scenario.kind === 'webdav' ? 1 : 0);
    if (scenario.linked) assert.equal(linkedClosed, 1);
    assert.deepEqual(await fs.readdir(spoolRoot), []); assert.deepEqual(await counts(), emptyCounts);
    assert.ok(handles.every(handle => handle.fd === -1));
    active = undefined; vfs.write = write;
    const recoveryContext = { ...context, getPeople: async () => [], prepareLinkedXmlItems: async () => {
      relation = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId });
        await writer.append({ Path: 'Z:\\Media\\one.mkv', Type: 0 }); await writer.append({ Path: 'Z:\\Media\\one.mkv', Type: 0 });
        return writer.finish();
      });
      return { manualCount: 2n, pages: options => links.pages(relation, options), async close() {
        const owned = relation; relation = undefined; await links.release(owned);
      } };
    } };
    await saver.save(item, recoveryContext);
    const recovered = await fs.readFile(filename);
    assert.equal((recovered.toString().match(/<Path>Z:\\Media\\one.mkv<\/Path>/gu) ?? []).length, 2);
    assert.deepEqual(await fs.readdir(spoolRoot), []); assert.deepEqual(await counts(), emptyCounts);
    await fs.writeFile(path.join(root, scenario.label + '.json'), JSON.stringify({ label: scenario.label, failure: errorObservation(failed.error),
      partialBytes: bytes.toString('base64'), recoveryBytes: recovered.toString('base64'), uploadCount, linkedClosed,
      released: await counts(), handlesClosed: handles.filter(handle => handle.fd === -1).length }, null, 2) + '\n');
  });
  await t.test('actual spool read and close failures both survive reader cancellation', async t => {
    const spool = await networkXmlSpool(spoolRoot, fileSystem);
    t.after(async () => { active = undefined; await spool.dispose(); });
    await spool.sink.write(Buffer.from('Actual frame bytes before the failing EOF.'));
    const prepared = await spool.prepare();
    const readFailure = Object.assign(new Error('Actual spool EOF failed.'), { code: 'EIO' });
    active = { readFails: true, readFailure, readerCloseFails: true };
    const bytes = [];
    const failed = await outcome((async () => { for await (const part of prepared.stream()) bytes.push(part); })());
    assert.deepEqual(flatten(failed.error), [readFailure, false]); assert.equal(failed.error.code, 'EIO');
    assert.equal(Buffer.concat(bytes).toString(), 'Actual frame bytes before the failing EOF.');
    active = undefined; await spool.dispose();
    assert.deepEqual(await fs.readdir(spoolRoot), []); assert.ok(handles.every(handle => handle.fd === -1));
    await fs.writeFile(path.join(root, 'spool-read-close.json'), JSON.stringify({ failure: errorObservation(failed.error), bytes: Buffer.concat(bytes).toString('base64'), spoolEmpty: true }, null, 2) + '\n');
  });
});
