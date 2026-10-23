import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sequence = values => ({ async count() { return BigInt(values.length); }, async *pages() { yield values; } });

test('postgres: a runtime without metadata context has no library scheduler consumers or owner', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(null, 'scheduler_empty', { max: 1 });
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
  runtime = await createRuntime({ database, serverId: 'library-scheduler-pathless', configuration: {}, vfs: {} });
  assert.equal(runtime.libraryTaskScheduler, undefined);
  assert.equal(runtime.metadataScanner, undefined);
  assert.equal(runtime.folderValidation, undefined);
});

for (const max of [1, 2]) test(`postgres: shared scheduler preserves nested SQL transactions and cohort lifetime with pool.max=${max}`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30_000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'library-scheduler-runtime-'));
  const database = await createPostgresTestDatabase(null, 'scheduler_sql', { max });
  let runtime;
  const cohorts = [], items = [];
  t.after(async () => {
    try {
      for (const cohort of cohorts) await cohort.release();
      for (const item of items) releaseNativeItemLinks(item);
      await runtime?.close();
    } finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(directory), os.tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  });
  runtime = await createRuntime({ database, programDataPath: path.join(directory, 'data'),
    configurationDirectoryPath: path.join(directory, 'config'), configuration: { LibraryScanFanoutConcurrency: 2 },
    serverId: 'library-scheduler-isolated' });
  const scheduler = runtime.libraryTaskScheduler;
  assert.equal(runtime.metadataScanner.scheduler, scheduler);
  assert.equal(runtime.folderValidation.scheduler, scheduler);
  for (let parent = 0; parent < 2; parent++) {
    const cohort = await createNativeItemCohort({ linkedChildren: runtime.linkedChildren });
    cohorts.push(cohort);
    for (let child = 0; child < 2; child++) {
      const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
      item.Id = `83000000-0000-0000-0000-${String(parent * 2 + child + 1).padStart(12, '0')}`;
      item.Name = `Frozen child ${parent}/${child}`;
      items.push(item);
      await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: item.Id, Type: item.NativeType,
        Name: `Stored child ${parent}/${child}`, Data: '{}' }));
      await cohort.capture(item, { ordinal: BigInt(child + 1) });
    }
  }
  const errors = [], seen = [], sessions = new Map();
  await scheduler.enqueue(sequence([0, 1]), parent => runtime.store.transaction(async parentSession => {
    sessions.set(parent, parentSession);
    const metadata = { validateRefresh() {}, async refreshLiveItem(reference) {
      await runtime.store.run(async nestedSession => {
        assert.equal(nestedSession, parentSession, 'Nested inline work must retain its parent transaction.');
        await tick();
        await nestedSession.update('BaseItems', { Id: reference.Id }, { Name: `Refreshed child of ${parent}` });
        seen.push([parent, reference.Id]);
      });
      return { UpdateType: 0, Failures: 0 };
    } };
    const scanner = new LibraryMetadataScanService({ library: runtime.library, metadata, scheduler });
    const children = metadataChildSequence(cohorts[parent].retain(), runtime.linkedChildren, runtime.store);
    const result = await scanner.refreshAccessibleChildren(children, {}, { recursive: false });
    assert.equal(result.attemptedCount, 2); assert.deepEqual(result.errors, []);
  }), { onError: error => errors.push(error) });
  assert.deepEqual(errors, []); assert.equal(seen.length, 4); assert.equal(sessions.size, 2);
  if (max === 2) assert.notEqual(sessions.get(0), sessions.get(1), 'Separate pooled workers must not inherit one SQL session.');
  for (const item of items) assert.match((await database.rows('BaseItems', { where: { Id: item.Id } }))[0].Name, /^Refreshed child of [01]$/u);
  await runtime.linkedChildren.flushReleases();
  for (const cohort of cohorts) assert.equal(await cohort.count(), 2n);
});

test('postgres: runtime drains shared scheduler callbacks before closing metadata savers or persistence', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30_000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'library-scheduler-close-'));
  const database = await createPostgresTestDatabase(null, 'scheduler_close', { max: 1 });
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); } finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(directory), os.tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  });
  runtime = await createRuntime({ database, programDataPath: path.join(directory, 'data'),
    configurationDirectoryPath: path.join(directory, 'config'), configuration: { LibraryScanFanoutConcurrency: 2 },
    serverId: 'library-scheduler-close-isolated' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  const stop = runtime.metadata.saver.stop.bind(runtime.metadata.saver);
  runtime.metadata.saver.stop = async () => { calls.push('saver-stop'); await stop(); };
  const work = runtime.libraryTaskScheduler.enqueue(sequence([0]), async () => {
    entered.resolve(); await release.promise;
    await runtime.store.run(db => db.client.query('SELECT 1'));
    calls.push('worker-complete');
  });
  await entered.promise;
  const closing = runtime.close(); await tick(); assert.deepEqual(calls, []);
  release.resolve(); await Promise.all([work, closing]);
  assert.ok(calls.indexOf('worker-complete') < calls.indexOf('saver-stop'));
});
