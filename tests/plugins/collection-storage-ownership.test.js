import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { createVirtualPathReverser } from '../../src/library/options.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
const databaseFailure = value => value != null && (typeof value.code === 'string' && /^[0-9A-Z]{5}$/u.test(value.code)
  || /Client was closed|Connection terminated/u.test(value.message ?? '')
  || value.errors?.some(databaseFailure) || databaseFailure(value.cause));
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The creating collection still owns its original storage generation.');
}

test('Collection creation preserves actual filesystem and PostgreSQL failure prefixes while draining every owner', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'collection-storage-ownership-'));
  for (const phase of ['directory-failure', 'repository-failure', 'monitor-failure', 'consumer-and-release-failures']) {
    await t.test(phase, async t => {
      const work = path.join(root, phase), programDataPath = path.join(work, 'program');
      const report = { phase, backgroundErrors: [], cleanupErrors: [] };
      let database, runtime, selected = false, primary, observed, consumeCalls = 0, itemReleased = false, parentReleased = false;
      const pendingRelations = [];
      t.after(async () => {
        selected = false;
        if (phase === 'repository-failure' && database) {
          try {
            await database.client.query(`DROP TRIGGER IF EXISTS reject_collection_owner ON ${q(database.schemaName)}."BaseItems";
              DROP FUNCTION IF EXISTS ${q(database.schemaName)}.reject_collection_owner()`);
          } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
        }
        for (const relation of pendingRelations) try { await runtime?.collections.linkedChildren.release(relation); }
        catch (error) { report.cleanupErrors.push(errorObservation(error)); }
        try { await runtime?.close(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
        await fs.writeFile(path.join(root, phase + '.json'), JSON.stringify(report, null, 2) + '\n');
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
        assert.deepEqual(report.cleanupErrors, []);
        assert.ok(report.backgroundErrors.every(error => !databaseFailure(error)), 'Runtime shutdown must precede database disposal.');
      });
      database = await createPostgresTestDatabase(t, 'collection_owner');
      runtime = await createTestRuntime({ database, programDataPath, serverId: 'collection-storage-ownership',
        configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
        onError: error => report.backgroundErrors.push(errorObservation(error)) });
      const parent = await runtime.collections.getCollectionsFolder(true);
      assert.ok(parent); assert.equal(runtime.plugins.get('local').enabled, true);
      const name = 'Owned Collection', filename = path.join(parent.Path, name + ' [boxset]');
      const sentinel = Buffer.from('This existing file is not owned by the failed directory creation.');
      if (phase === 'directory-failure') await fs.writeFile(filename, sentinel);
      if (phase === 'repository-failure') {
        // The real CreateItems INSERT is rejected by the actual database, after
        // CollectionService has already created its real directory.
        await database.client.query(`CREATE FUNCTION ${q(database.schemaName)}.reject_collection_owner() RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN RAISE EXCEPTION 'The owned collection insert was rejected.' USING ERRCODE='23514'; END $body$;
          CREATE TRIGGER reject_collection_owner BEFORE INSERT ON ${q(database.schemaName)}."BaseItems"
          FOR EACH ROW WHEN (NEW."Name"=decode('${nativeTextBytes(name).toString('hex')}','hex'))
          EXECUTE FUNCTION ${q(database.schemaName)}.reject_collection_owner()`);
      }
      const monitor = runtime.collections.monitor;
      const complete = monitor.reportFileSystemChangeComplete?.bind(monitor);
      monitor.reportFileSystemChangeComplete = async (...args) => {
        await complete?.(...args);
        if (selected && args[0] === filename && phase !== 'consumer-and-release-failures') {
          throw phase === 'directory-failure' ? false : phase === 'repository-failure' ? 0 : '';
        }
      };
      const links = runtime.collections.linkedChildren;
      if (phase === 'consumer-and-release-failures') {
        for (let index = 0; index < 2; index++) pendingRelations.push(await links.withSession(async session => {
          const writer = await links.createWriter({ session, parentId: parent.Id });
          await writer.append({ Path: `owned-release-${index}`, Type: 0 });
          return writer.finish();
        }));
        const retain = runtime.itemCreation.retainItem.bind(runtime.itemCreation);
        let parentWrapped = false, itemWrapped = false;
        runtime.itemCreation.retainItem = item => {
          const owner = retain(item);
          const isParent = selected && !parentWrapped && item.Id === parent.Id;
          const isItem = selected && !itemWrapped && item.Type === 'BoxSet' && item.Path == null;
          if (!isParent && !isItem) return owner;
          if (isParent) parentWrapped = true; else itemWrapped = true;
          return { release() {
            owner.release();
            if (isParent) { parentReleased = true; links.queueRelease(pendingRelations[1]); throw 0; }
            itemReleased = true; links.queueRelease(pendingRelations[0]); throw false;
          } };
        };
      }
      const events = [];
      runtime.collections.on('CollectionCreated', event => { if (event.Collection.Name === name) events.push(event.Collection.Id); });
      selected = true;
      const result = await runtime.collections.withCreatedItem({ Name: name, ItemIdList: [] }, async () => {
        consumeCalls++;
        try { await database.client.query('SELECT missing_collection_consumer_column FROM "BaseItems"'); }
        catch (error) { primary = error; throw error; }
      }).then(value => ({ value }), error => ({ error }));
      selected = false;
      assert.ok(Object.hasOwn(result, 'error')); observed = result.error;
      report.failure = errorObservation(observed);
      const reasons = flatten(observed);
      if (phase === 'directory-failure') {
        assert.equal(reasons.length, 2); assert.equal(reasons[0].code, 'EEXIST'); assert.equal(reasons[1], false);
        assert.deepEqual(await fs.readFile(filename), sentinel);
      } else if (phase === 'repository-failure') {
        assert.equal(reasons.length, 2); assert.equal(reasons[0].code, '23514'); assert.equal(reasons[1], 0);
        assert.equal((await fs.stat(filename)).isDirectory(), true);
      } else if (phase === 'monitor-failure') assert.equal(observed, '');
      else {
        assert.equal(primary.code, '42703'); assert.deepEqual(reasons, [primary, false, 0]);
        assert.equal(itemReleased, true); assert.equal(parentReleased, true);
        for (const relation of pendingRelations) {
          const remaining = await database.client.query(`SELECT count(*) AS count FROM ${links.sets} WHERE id=$1`, [relation.entry.id]);
          assert.equal(Number(remaining.rows[0].count), 0, 'Each real queued SQL relation must be collected before the failure is returned.');
        }
      }
      const rows = await database.rows('BaseItems', { where: { Name: name } });
      const committed = ['monitor-failure', 'consumer-and-release-failures'].includes(phase);
      assert.equal(rows.length, committed ? 1 : 0); assert.equal(events.length, committed ? 1 : 0);
      assert.equal(consumeCalls, phase === 'consumer-and-release-failures' ? 1 : 0);
      if (committed) {
        assert.equal(rows[0].Path, createVirtualPathReverser(runtime.library.options)(filename));
        assert.equal(runtime.library.options.expandPath(rows[0].Path), filename);
        assert.equal((await fs.stat(filename)).isDirectory(), true);
      }
      const recovered = await runtime.collections.create({ Name: 'Recovered Collection', ItemIdList: [] });
      assert.equal((await database.rows('BaseItems', { where: { Id: recovered.Id } })).length, 1);
      assert.equal((await fs.stat(recovered.Path)).isDirectory(), true);
      report.observations = { committed, createdEvents: events.length, consumeCalls, itemReleased, parentReleased,
        pendingRelationsCollected: pendingRelations.length, recoveredPath: recovered.Path };
    });
  }
});

test('Collection CreateItems owns its real Local generation until persistence and releases it before later consumers', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'collection-storage-generation-'));
  for (const mode of ['replace', 'stop', 'replace-mkdir-only', 'replace-exact-prefix']) await t.test(mode, async t => {
    const work = path.join(root, mode), programDataPath = path.join(work, 'program');
    const oldTarget = path.join(work, 'target-a'), newTarget = path.join(work, 'target-b');
    for (const directory of [oldTarget, newTarget]) await fs.mkdir(directory, { recursive: true });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), changing = Promise.withResolvers();
    const consuming = Promise.withResolvers(), releaseConsumer = Promise.withResolvers();
    const report = { mode, backgroundErrors: [], cleanupErrors: [] }, queued = [];
    let database, runtime, creating, transition, ownedFiles, ownedClosed = false, selected = false, held = false, oldInfo;
    let ownedPathReads = 0, unsubscribe = () => {};
    t.after(async () => {
      selected = false; release.resolve(); releaseConsumer.resolve(); unsubscribe();
      await Promise.allSettled([creating, transition]);
      try { if (runtime?.plugins.get('local').enabled === false) await runtime.plugins.setEnabled('local', true); }
      catch (error) { report.cleanupErrors.push(errorObservation(error)); }
      try { await runtime?.close(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
      await fs.writeFile(path.join(root, mode + '.json'), JSON.stringify(report, null, 2) + '\n');
      assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
      assert.deepEqual(report.cleanupErrors, []);
      assert.ok(report.backgroundErrors.every(error => !databaseFailure(error)), 'Runtime shutdown must precede database disposal.');
    });
    database = await createPostgresTestDatabase(t, 'collection_generation');
    runtime = await createTestRuntime({ database, programDataPath, serverId: 'collection-storage-generation',
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      onError: error => report.backgroundErrors.push(errorObservation(error)) });
    const parent = await runtime.collections.getCollectionsFolder(true), storage = runtime.storage;
    assert.ok(parent); assert.equal(runtime.plugins.get('local').enabled, true);
    const definition = storage.configuration(), restricted = mode === 'replace-mkdir-only', exactPrefix = mode === 'replace-exact-prefix';
    const name = 'Owned generation', basename = name + ' [boxset]', filename = path.join(parent.Path, basename);
    const targetSuffix = exactPrefix ? ['missing', 'parents', 'actual-directory'] : [basename];
    definition.instances.push({ id: 'collection-target', type: 'local', config: { root: oldTarget, writable: true } });
    definition.mounts.push({ path: '/owned-collections', instanceId: 'collection-target', capabilities: restricted ? { mkdir: true } : capabilities });
    definition.prefixes.push({ identityRoot: exactPrefix ? filename : parent.Path,
      accessRoot: exactPrefix ? '/owned-collections/' + targetSuffix.join('/') : '/owned-collections',
      style: process.platform === 'win32' ? 'windows' : 'posix', purpose: 'application', returnAccess: 'Retain the managed Collection identity.' });
    await storage.configure(definition);
    const oldDirectory = path.join(oldTarget, ...targetSuffix), newDirectory = path.join(newTarget, ...targetSuffix);
    const sentinel = Buffer.from('This directory and its content belong to the replacement generation.');
    await fs.mkdir(newDirectory, { recursive: true }); await fs.writeFile(path.join(newDirectory, 'sentinel.txt'), sentinel);
    if (exactPrefix) await assert.rejects(fs.stat(path.dirname(oldDirectory)), { code: 'ENOENT' });
    await fs.utimes(newDirectory, new Date('2023-04-05T06:07:08Z'), new Date('2023-04-05T06:07:08Z'));
    const replacementInfo = await fs.stat(newDirectory, { bigint: true });
    const oldAdapter = storage.vfs.resolve('/owned-collections').adapter;
    const queue = runtime.metadata.queue.bind(runtime.metadata);
    runtime.metadata.queue = (...args) => {
      const operation = queue(...args); queued.push({ id: args[0], work: outcome(operation) }); return operation;
    };
    const retain = storage.fileSystem.retainDirectories;
    storage.fileSystem.retainDirectories = (...args) => {
      const owner = retain(...args);
      if (!selected || !args[0].includes(parent.Path)) return owner;
      ownedFiles = new Proxy(owner.fileSystem, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'mkdir') return async (...args) => {
          await value.apply(target, args);
          if (args[0] === filename && !held) {
            held = true;
            await fs.utimes(oldDirectory, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'));
            oldInfo = await fs.stat(oldDirectory, { bigint: true });
            entered.resolve(); await release.promise;
          }
        };
        if (key === 'realpath') return async (...args) => {
          const result = await value.apply(target, args);
          if (held && args[0] === filename) ownedPathReads++;
          return result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return { fileSystem: ownedFiles, async close() { await owner.close(); ownedClosed = true; } };
    };
    selected = true;
    creating = outcome(runtime.collections.withCreatedItem({ Name: name, ItemIdList: [] }, async item => {
      consuming.resolve(item); await releaseConsumer.promise; return item;
    }));
    await Promise.race([entered.promise, creating.then(result => { throw result.error ?? new Error('Collection mkdir did not reach the real resource barrier.'); })]);
    await pending(creating); assert.equal(ownedClosed, false);
    assert.notEqual(oldInfo.mtimeNs, replacementInfo.mtimeNs);
    await assert.rejects(storage.vfs.mkdir('/owned-collections'), { code: 'permission-denied' });
    await assert.rejects(ownedFiles.vfs.mkdir('/owned-collections'), { code: 'permission-denied' });
    if (restricted) {
      // Default spool-style retention still requires create/delete. Collection
      // only skips that preflight; the retained mount enforces every operation.
      assert.throws(() => storage.fileSystem.retainDirectories([parent.Path]), { code: 'not-supported' });
      await assert.rejects(ownedFiles.writeFile(path.join(filename, 'forbidden.txt'), 'forbidden'), { code: 'ENOTSUP' });
      await assert.rejects(ownedFiles.rm(filename, { recursive: true }), { code: 'ENOTSUP' });
      assert.deepEqual(await fs.readdir(oldDirectory), []);
    }
    unsubscribe = storage.subscribeBeforeChange(() => changing.resolve());
    const next = structuredClone(definition);
    if (mode === 'stop') transition = runtime.plugins.setEnabled('local', false);
    else {
      next.instances.find(instance => instance.id === 'collection-target').config.root = newTarget;
      transition = storage.configure(next);
    }
    void transition.catch(() => {}); await changing.promise; await pending(transition); unsubscribe();
    if (mode === 'stop') await assert.rejects(async () => oldAdapter.stat('/'), { status: 503 });
    release.resolve();
    const item = await Promise.race([consuming.promise, creating.then(result => { throw result.error ?? new Error('Collection persistence did not reach its consumer.'); })]);
    assert.equal(ownedClosed, true);
    await assert.rejects(ownedFiles.stat(filename), { code: 'closed' });
    // Both post-mkdir validation and the real metadata context must use the
    // captured owner. A metadata loader that silently recaptures storage fails.
    assert.ok(ownedPathReads >= 2);
    await transition; await pending(creating);
    const row = (await database.rows('BaseItems', { where: { Id: item.Id } }))[0];
    assert.equal(row.Name, name); assert.equal(row.Path, createVirtualPathReverser(runtime.library.options)(filename));
    assert.equal(runtime.library.options.expandPath(row.Path), filename);
    assert.equal(row.DateModified, nativeDateFromUnixNanoseconds(oldInfo.mtimeNs));
    assert.deepEqual(await fs.readdir(oldDirectory), []);
    assert.deepEqual(await fs.readdir(newDirectory), ['sentinel.txt']);
    assert.deepEqual(await fs.readFile(path.join(newDirectory, 'sentinel.txt')), sentinel);
    releaseConsumer.resolve(); const result = await creating; selected = false;
    assert.equal(Object.hasOwn(result, 'error'), false);
    const refresh = queued.find(entry => entry.id === item.Id); assert.ok(refresh);
    const refreshed = await refresh.work;
    if (Object.hasOwn(refreshed, 'error')) {
      report.initialRefreshFailure = errorObservation(refreshed.error);
      assert.ok(flatten(refreshed.error).every(error => error?.code !== 'closed'), 'Detached metadata refresh must capture current storage.');
    }
    if (mode === 'replace' || exactPrefix) assert.equal(Object.hasOwn(refreshed, 'error'), false);
    if (mode === 'stop') await runtime.plugins.setEnabled('local', true);
    if (restricted) {
      next.mounts.find(mount => mount.path === '/owned-collections').capabilities = capabilities;
      await storage.configure(next);
    }
    // A later real metadata context must use current storage, never the closed
    // filesystem retained only for the initial CreateItems boundary.
    await runtime.collections.loadContext.withContext(item.Id, {}, async loaded => {
      assert.equal(loaded.fileSystem, runtime.fileSystem); assert.notEqual(loaded.fileSystem, ownedFiles);
      assert.equal((await loaded.imageAssets.stat(filename)).kind, 'directory');
    });
    const recovered = await runtime.collections.create({ Name: 'Recovered generation', ItemIdList: [] });
    const recoveryRoot = mode === 'stop' ? oldTarget : exactPrefix ? parent.Path : newTarget;
    assert.equal((await fs.stat(path.join(recoveryRoot, path.basename(recovered.Path)))).isDirectory(), true);
    assert.equal((await database.rows('BaseItems', { where: { Id: recovered.Id } })).length, 1);
    const recoveredRefresh = queued.find(entry => entry.id === recovered.Id); assert.ok(recoveredRefresh);
    assert.equal(Object.hasOwn(await recoveredRefresh.work, 'error'), false);
    if (mode !== 'stop') await assert.rejects(fs.stat(path.join(oldTarget, path.basename(recovered.Path))), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(newDirectory, 'sentinel.txt')), sentinel);
    report.observations = { ownedPathReads, releasedBeforeConsumer: ownedClosed, persistedPath: row.Path,
      originalModified: row.DateModified, replacementModified: nativeDateFromUnixNanoseconds(replacementInfo.mtimeNs),
      restrictedOperationsRejected: restricted, exactPrefix, originalMountRootProtected: true, recoveredPath: recovered.Path };
  });
});
