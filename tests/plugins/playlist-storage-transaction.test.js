import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { nativeGuid } from '../../src/users/native.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'Storage must retain the complete playlist transaction and its rollback.');
}

test('managed Playlist transactions retain actual backups, sidecars and rollback across storage replacement and Local stop', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-storage-transaction-'));
  for (const mode of ['replace', 'stop']) for (const phase of ['after-backup', 'after-rename', 'commit-rejection', 'backup-copy-rejection',
    'sidecar-write-close-remove', 'serialized-cleanup', 'open-collision']) {
    await t.test(`${mode}/${phase}`, async t => {
      const name = `${mode}-${phase}`, work = path.join(root, name), programDataPath = path.join(work, 'program');
      const oldTarget = path.join(work, 'target-a'), newTarget = path.join(work, 'target-b');
      const oldSpool = path.join(work, 'spool-a'), newSpool = path.join(work, 'spool-b');
      for (const directory of [oldTarget, newTarget, oldSpool, newSpool]) await fs.mkdir(directory, { recursive: true });
      const database = await createPostgresTestDatabase(t, 'playlist_tx');
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), changing = Promise.withResolvers();
      const report = { mode, phase, backgroundErrors: [], cleanupErrors: [] }, handles = [], sentinels = new Map();
      const sentinel = Buffer.from('The replacement backend owns this filename.');
      let runtime, updating, transition, held = false, selected = false, backup, collision;
      t.after(async () => {
        release.resolve(); await Promise.allSettled([updating, transition]);
        try { if (runtime?.plugins.get('local').enabled === false) await runtime.plugins.setEnabled('local', true); }
        catch (error) { report.cleanupErrors.push(errorObservation(error)); }
        try { await runtime?.close(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
        await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2) + '\n');
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
        assert.deepEqual(report.cleanupErrors, []);
      });
      runtime = await createTestRuntime({ database, programDataPath, serverId: 'playlist-storage-transaction',
        configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
        onError: error => report.backgroundErrors.push(errorObservation(error)) });
      const storage = runtime.storage, dataPath = path.join(programDataPath, 'data');
      const playlistsPath = path.join(dataPath, 'playlists'), spoolRoot = path.join(dataPath, 'metadata-spool');
      const definition = storage.configuration();
      definition.instances.push({ id: 'playlist-target', type: 'local', config: { root: oldTarget, writable: true } },
        { id: 'playlist-spool', type: 'local', config: { root: oldSpool, writable: true } });
      definition.mounts.push({ path: '/owned-playlists', instanceId: 'playlist-target', capabilities },
        { path: '/owned-spool', instanceId: 'playlist-spool', capabilities });
      for (const [identityRoot, accessRoot] of [[playlistsPath, '/owned-playlists'], [spoolRoot, '/owned-spool']]) definition.prefixes.push({
        identityRoot, accessRoot, style: process.platform === 'win32' ? 'windows' : 'posix', purpose: 'application', returnAccess: 'Retain the managed Playlist identity.',
      });
      await storage.configure(definition);
      const createdUser = await runtime.users.createUser({ Name: 'Playlist storage owner', Password: 'owned-test-password' });
      const user = await runtime.users.getUser(createdUser.Id);
      const created = await runtime.playlists.create({ name: 'Owned playlist', ids: [], user });
      const id = nativeGuid(created.Id), beforeRow = (await database.rows('BaseItems', { where: { Id: id } }))[0];
      const folder = path.basename(beforeRow.Path), oldFile = path.join(oldTarget, folder, 'playlist.xml');
      const newFolder = path.join(newTarget, folder), newFile = path.join(newFolder, 'playlist.xml');
      await fs.mkdir(newFolder, { recursive: true }); await fs.writeFile(newFile, sentinel); sentinels.set(newFile, sentinel);
      const before = await fs.readFile(oldFile), oldAdapter = storage.vfs.resolve('/owned-playlists').adapter;
      const nextName = phase === 'commit-rejection' ? 'Rejected transaction' : 'Committed transaction';
      if (phase === 'commit-rejection') {
        // This real deferred constraint fails at COMMIT, after the real rename.
        // The production database transaction must roll back before FS restore.
        await database.client.query(`CREATE FUNCTION ${q(database.schemaName)}.reject_playlist_commit() RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN RAISE EXCEPTION 'The owned playlist transaction was rejected.' USING ERRCODE='23514'; END $body$;
          CREATE CONSTRAINT TRIGGER reject_playlist_commit AFTER UPDATE ON ${q(database.schemaName)}."BaseItems"
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."Name"=decode('${nativeTextBytes(nextName).toString('hex')}','hex'))
          EXECUTE FUNCTION ${q(database.schemaName)}.reject_playlist_commit()`);
      }
      const hold = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
      const observe = files => new Proxy(files, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (['retainDirectory', 'retainDirectories'].includes(key)) return (...args) => {
          const owner = value.apply(target, args); return { ...owner, fileSystem: observe(owner.fileSystem) };
        };
        if (key === 'copyFile') return async (source, destination) => {
          await value.call(target, source, destination);
          if (selected && path.basename(destination).startsWith('playlist-backup-')) {
            backup = path.basename(destination); assert.deepEqual(await fs.readFile(path.join(oldSpool, backup)), before);
            if (mode === 'replace') { const filename = path.join(newSpool, backup); await fs.writeFile(filename, sentinel); sentinels.set(filename, sentinel); }
            if (['after-backup', 'backup-copy-rejection', 'sidecar-write-close-remove', 'open-collision'].includes(phase)) await hold();
            // The real copy has already created the owned backup. Reject before
            // returning it to exercise cleanup of an undelivered copy.
            if (phase === 'backup-copy-rejection') throw false;
          }
        };
        if (key === 'open') return async (...args) => {
          const sidecar = selected && path.basename(args[0]).startsWith('.playlist-');
          if (sidecar && phase === 'open-collision') {
            collision = path.join(path.dirname(oldFile), path.basename(args[0]));
            await fs.writeFile(collision, sentinel, { flag: 'wx' });
          }
          const file = await value.apply(target, args); handles.push(file);
          if (sidecar && mode === 'replace') {
            const filename = path.join(newFolder, path.basename(args[0])); await fs.writeFile(filename, sentinel); sentinels.set(filename, sentinel);
          }
          if (sidecar && phase === 'sidecar-write-close-remove') return new Proxy(file, { get(target, key) {
            const operation = Reflect.get(target, key, target);
            if (key === 'write') return async (...args) => { await operation.apply(target, args); throw false; };
            if (key === 'close') return async (...args) => { await operation.apply(target, args); throw 0; };
            return typeof operation === 'function' ? operation.bind(target) : operation;
          } });
          return file;
        };
        if (key === 'rm') return async (...args) => {
          await value.apply(target, args);
          if (selected && phase === 'sidecar-write-close-remove' && path.basename(args[0]).startsWith('.playlist-')) throw '';
        };
        if (key === 'unlink') return async (...args) => {
          await value.apply(target, args);
          if (selected && phase === 'serialized-cleanup' && path.basename(args[0]) === 'frame.xml') throw false;
        };
        if (key === 'rename') return async (...args) => {
          await value.apply(target, args);
          if (selected && phase !== 'after-backup') await hold();
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const retain = storage.fileSystem.retainDirectories;
      storage.fileSystem.retainDirectories = (...args) => { const owner = retain(...args); return { ...owner, fileSystem: observe(owner.fileSystem) }; };
      selected = true; updating = outcome(runtime.playlists.update(created.Id, { user, name: nextName }));
      await Promise.race([entered.promise, updating.then(result => { throw result.error ?? new Error('The real Playlist write did not reach its barrier.'); })]);
      assert.ok(backup); await pending(updating);
      const unsubscribe = storage.subscribeBeforeChange(() => changing.resolve());
      if (mode === 'stop') transition = runtime.plugins.setEnabled('local', false);
      else {
        const next = structuredClone(definition);
        next.instances.find(instance => instance.id === 'playlist-target').config.root = newTarget;
        next.instances.find(instance => instance.id === 'playlist-spool').config.root = newSpool;
        transition = storage.configure(next);
      }
      void transition.catch(() => {}); await changing.promise; await pending(transition); unsubscribe();
      if (mode === 'stop') await assert.rejects(async () => oldAdapter.stat('/'), { status: 503 });
      release.resolve(); const result = await updating; await transition; selected = false;
      if (Object.hasOwn(result, 'error')) report.operationFailure = errorObservation(result.error);
      const after = await fs.readFile(oldFile), row = (await database.rows('BaseItems', { where: { Id: id } }))[0];
      if (phase === 'commit-rejection') {
        // COMMIT rejection retires the connection; the enclosing writer lock
        // reports its failed release after the original PostgreSQL failure.
        assert.equal(result.error.cause.code, '23514');
        assert.equal(result.error.errors.length, 2); assert.equal(result.error.errors[0], result.error.cause);
        assert.equal(result.error.errors[1].cause, result.error.cause);
        assert.deepEqual(row, beforeRow); assert.deepEqual(after, before);
        report.commitFailure = errorObservation(result.error);
      } else if (phase === 'backup-copy-rejection') {
        assert.equal(result.error, false); assert.deepEqual(row, beforeRow); assert.deepEqual(after, before);
        report.copyFailure = errorObservation(result.error);
      } else if (['sidecar-write-close-remove', 'serialized-cleanup', 'open-collision'].includes(phase)) {
        assert.deepEqual(row, beforeRow); assert.deepEqual(after, before);
        if (phase === 'sidecar-write-close-remove') { assert.equal(result.error.cause, false); assert.deepEqual(result.error.errors, [false, 0, '']); }
        if (phase === 'serialized-cleanup') assert.deepEqual(result.error.errors, [false]);
        if (phase === 'open-collision') {
          assert.equal(result.error.code, 'EEXIST'); assert.deepEqual(await fs.readFile(collision), sentinel);
          report.existingSidecarPreserved = true;
          await fs.unlink(collision);
        }
      } else { assert.equal(result.error, undefined); assert.equal(row.Name, nextName); assert.ok(after.toString().includes(nextName)); }
      assert.deepEqual(await fs.readdir(oldSpool), []); assert.deepEqual(await fs.readdir(path.dirname(oldFile)), ['playlist.xml']);
      if (phase !== 'backup-copy-rejection') assert.ok(handles.length > 0);
      assert.ok(handles.every(file => file.fd === -1));
      for (const [filename, bytes] of sentinels) assert.deepEqual(await fs.readFile(filename), bytes);
      if (mode === 'stop') await runtime.plugins.setEnabled('local', true);
      await runtime.playlists.update(created.Id, { user, name: 'Recovered transaction' });
      const recovered = await fs.readFile(mode === 'replace' ? newFile : oldFile); assert.ok(recovered.toString().includes('Recovered transaction'));
      assert.equal((await database.rows('BaseItems', { where: { Id: id } }))[0].Name, 'Recovered transaction');
      if (mode === 'replace') {
        assert.deepEqual(await fs.readFile(oldFile), after);
        for (const [filename, bytes] of sentinels) if (filename !== newFile) assert.deepEqual(await fs.readFile(filename), bytes);
      }
      assert.deepEqual(await fs.readdir(oldSpool), []);
      report.observations = { backupRemoved: true, nativeHandlesClosed: handles.length, replacementNamesPreserved: sentinels.size,
        originalXml: before.toString('base64'), afterTransactionXml: after.toString('base64'), recoveryXml: recovered.toString('base64') };
    });
  }
});
