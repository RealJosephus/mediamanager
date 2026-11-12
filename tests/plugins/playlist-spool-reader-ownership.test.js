import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { preparePlaylistFile, serializePlaylistFile } from '../../src/library/playlist-file.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { openConfiguredPluginHost } from './configuration-host.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
async function pending(work) {
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The spool still owns an admitted reader operation.');
}

test('Playlist spool close drains real reader opens, reads and closes before replacement or Local stop can finish', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-spool-reader-ownership-'));
  for (const mode of ['replace', 'stop']) for (const stage of ['open', 'read', 'close']) for (const faulty of [false, true]) {
    await t.test(`${mode}/${stage}/${faulty ? 'close-false' : 'success'}`, async t => {
      const name = `${mode}-${stage}-${faulty}`, work = path.join(root, name), oldRoot = path.join(work, 'old'), newRoot = path.join(work, 'new');
      await fs.mkdir(oldRoot, { recursive: true }); await fs.mkdir(newRoot, { recursive: true });
      const spoolRoot = path.join(work, 'identity'), report = { mode, stage, faulty, backgroundErrors: [], cleanupErrors: [] };
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), changing = Promise.withResolvers();
      let host, storage, database, links, cohort, prepared, iterator, reading, returning, closing, transition, selected = true, held = false;
      let reader, readCalls = 0, readerCloses = 0, unsubscribe = () => {};
      t.after(async () => {
        selected = false; release.resolve(); unsubscribe();
        const cleanup = async operation => { try { await operation(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); } };
        // A failed barrier assertion can leave the transition waiting for this
        // spool lease. Start its close before joining that transition.
        if (!closing) closing = cleanup(() => prepared?.close());
        await Promise.allSettled([reading, returning, closing, transition]);
        await cleanup(() => cohort?.release()); await cleanup(() => links?.flushOwnedReleases()); await cleanup(() => links?.flushReleases());
        await cleanup(() => storage?.close()); await cleanup(() => host?.close()); await cleanup(() => links?.close());
        if (database) await cleanup(() => dropPostgresTestDatabase(database));
        await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2) + '\n');
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
        assert.deepEqual(report.cleanupErrors, []);
      });
      database = await createPostgresTestDatabase(null, 'playlist_spool_reader');
      links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
      host = await openConfiguredPluginHost({ directory: path.join(work, 'host'), onError: error => report.backgroundErrors.push(errorObservation(error)) });
      storage = await createConfiguredStorage(undefined, { plugins: host });
      const definition = storage.configuration();
      definition.instances.push({ id: 'spool', type: 'local', config: { root: oldRoot, writable: true } });
      definition.mounts.push({ path: '/spool', instanceId: 'spool', capabilities });
      definition.prefixes.push({ identityRoot: spoolRoot, accessRoot: '/spool', style: process.platform === 'win32' ? 'windows' : 'posix',
        purpose: 'application', returnAccess: 'The real Playlist reader retains its original spool generation.' });
      await storage.configure(definition);
      const retain = storage.fileSystem.retainDirectory;
      storage.fileSystem.retainDirectory = (...args) => {
        const owner = retain(...args), open = owner.fileSystem.open.bind(owner.fileSystem);
        owner.fileSystem.open = async (identity, flags) => {
          const file = await open(identity, flags);
          if (flags !== 'r') return file;
          const read = file.read.bind(file), close = file.close.bind(file);
          const gate = async current => { if (selected && stage === current && !held) { held = true; entered.resolve(); await release.promise; } };
          reader = file; await gate('open');
          return new Proxy(file, { get(target, key) {
            if (key === 'read') return async (...values) => { const value = await read(...values); readCalls++; await gate('read'); return value; };
            if (key === 'close') return async () => { await gate('close'); await close(); readerCloses++; if (selected && faulty) throw false; };
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
          } });
        };
        return owner;
      };
      const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
      Object.assign(item, { Id: '51600000-0000-0000-0000-000000000001', Name: 'Actual owned reader', Path: path.join(work, 'song.mp3'), RunTimeTicks: 30000000n });
      cohort = await createNativeItemCohort({ linkedChildren: links }); await cohort.capture(item, { ordinal: 1n });
      const playlist = path.join(work, 'mix.m3u'), expected = serializePlaylistFile(playlist, [item]);
      prepared = await preparePlaylistFile(playlist, cohort, { fileSystem: storage.fileSystem, spoolRoot });
      const [temporary] = await fs.readdir(oldRoot); assert.ok(temporary);
      assert.deepEqual(await fs.readFile(path.join(oldRoot, temporary)), expected);
      iterator = prepared.stream()[Symbol.asyncIterator]();
      if (stage === 'close') {
        const first = await iterator.next(); assert.deepEqual(first.value, expected);
        returning = outcome(iterator.return());
      } else reading = outcome(iterator.next());
      const active = stage === 'close' ? returning : reading;
      await Promise.race([entered.promise, active.then(result => { throw result.error ?? new Error('The actual reader did not reach its resource barrier.'); })]);
      assert.ok(reader.fd >= 0);
      const sentinel = Buffer.from('The replacement owns this same spool filename.');
      if (mode === 'replace') await fs.writeFile(path.join(newRoot, temporary), sentinel);
      unsubscribe = storage.subscribeBeforeChange(() => changing.resolve());
      if (mode === 'stop') transition = host.setEnabled('local', false);
      else {
        const next = structuredClone(definition); next.instances.find(instance => instance.id === 'spool').config.root = newRoot;
        transition = storage.configure(next);
      }
      void transition.catch(() => {});
      await Promise.race([changing.promise, transition.then(() => {
        throw new Error('The storage transition completed before the real resource barrier.');
      })]);
      unsubscribe(); await pending(transition);
      const closeWork = prepared.close(); assert.equal(prepared.close(), closeWork);
      closing = outcome(closeWork); await pending(closing); await pending(transition);
      assert.ok(reader.fd >= 0); assert.deepEqual(await fs.readFile(path.join(oldRoot, temporary)), expected);
      release.resolve();
      const readResult = await active, closeResult = await closing;
      if (faulty) {
        assert.equal(Object.hasOwn(readResult, 'error'), true); assert.equal(readResult.error, false);
        assert.equal(Object.hasOwn(closeResult, 'error'), true); assert.equal(closeResult.error, false);
      } else {
        assert.equal(Object.hasOwn(readResult, 'error'), false); assert.equal(readResult.value.done, true);
        assert.equal(Object.hasOwn(closeResult, 'error'), false);
      }
      await transition; selected = false;
      assert.equal(reader.fd, -1); assert.equal(readerCloses, 1); assert.equal(readCalls, stage === 'open' ? 0 : 1);
      assert.deepEqual(await fs.readdir(oldRoot), []);
      if (mode === 'replace') assert.deepEqual(await fs.readFile(path.join(newRoot, temporary)), sentinel);
      else await host.setEnabled('local', true);
      const recovery = await preparePlaylistFile(playlist, cohort, { fileSystem: storage.fileSystem, spoolRoot });
      try {
        const bytes = []; for await (const part of recovery.stream()) bytes.push(part);
        assert.deepEqual(Buffer.concat(bytes), expected);
      } finally { await recovery.close(); }
      assert.deepEqual(await fs.readdir(oldRoot), []);
      if (mode === 'replace') assert.deepEqual(await fs.readdir(newRoot), [temporary]);
      assert.deepEqual(report.backgroundErrors, []);
      await cohort.release(); cohort = undefined; await links.flushOwnedReleases(); await links.flushReleases();
      const counts = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      assert.deepEqual(counts, { sets: 0, rows: 0, pins: 0 });
      report.observations = { expectedBytes: expected.toString('base64'), readResult: errorObservation(readResult.error),
        closeResult: errorObservation(closeResult.error), oldSpoolEmpty: true, originalReaderClosed: true,
        replacementSentinelPreserved: mode === 'replace', counts };
    });
  }
});
