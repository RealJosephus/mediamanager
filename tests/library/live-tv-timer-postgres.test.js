import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { DomainStore } from '../../src/database/domain-store.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { liveTvStateKey } from '../../src/library/live-tv-state.js';
import { LiveTvTimersService } from '../../src/library/live-tv-timers-service.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

const hash = value => createHash('sha256').update(value).digest('hex');

async function bounded(promise, timeoutMs = 10_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      setTimeout(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Operation exceeded ${timeoutMs}ms`);
      }),
    ]);
  } finally { controller.abort(); }
}

function timerService(store, dataPath) {
  return new LiveTvTimersService({
    store,
    dataPath,
    serverId: 'live-tv-timer-postgres',
    loadProgramDtos: async () => new Map(),
  });
}

async function timerFixture(t, prefix, { timers, seriesTimers = '[]' }) {
  const dataPath = await mkdtemp(path.join(tmpdir(), 'mm-live-tv-timer-postgres-'));
  const stateDirectory = path.join(dataPath, 'livetv');
  const timerFile = path.join(stateDirectory, 'timers.json');
  const seriesFile = path.join(stateDirectory, 'seriestimers.json');
  let primaryDatabase, secondaryDatabase, primaryStore, secondaryStore, primaryService, secondaryService;
  t.after(async () => {
    const errors = [];
    for (const service of [primaryService, secondaryService]) if (service) {
      try { await service.close(); } catch (error) { errors.push(error); }
    }
    for (const store of [primaryStore, secondaryStore]) if (store) {
      try { await store.close(); } catch (error) { errors.push(error); }
    }
    try { await dropPostgresTestDatabase(primaryDatabase); } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(dataPath)), path.resolve(tmpdir()));
      assert.ok(path.basename(dataPath).startsWith('mm-live-tv-timer-postgres-'));
      await rm(dataPath, { recursive: true });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Live TV timer PostgreSQL fixture cleanup failed.');
  });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(timerFile, timers, { flag: 'wx' });
  await writeFile(seriesFile, seriesTimers, { flag: 'wx' });
  primaryDatabase = await createPostgresTestDatabase(null, prefix, { max: 3 });
  primaryStore = new DomainStore(primaryDatabase);
  assert.equal(await primaryStore.transaction(database => initializeLiveTvState(database, { dataPath })), true);
  secondaryDatabase = await PostgresDatabase.open({
    connectionString: postgresTestConnectionString,
    schema: primaryDatabase.schemaName,
    max: 3,
  });
  secondaryStore = new DomainStore(secondaryDatabase);
  primaryService = timerService(primaryStore, dataPath);
  secondaryService = timerService(secondaryStore, dataPath);
  return { dataPath, stateDirectory, timerFile, seriesFile, primaryDatabase, secondaryDatabase,
    primaryStore, secondaryStore, primaryService, secondaryService };
}

async function savedState(database) {
  const raw = await database.getState(liveTvStateKey);
  assert.equal(typeof raw, 'string');
  return { raw, value: JSON.parse(raw) };
}

async function assertSourceMatchesFile(database, kind, filename) {
  const { value } = await savedState(database), bytes = await readFile(filename);
  assert.equal(value[kind].sourceHex, bytes.toString('hex'));
  assert.equal(value[kind].sourceSha256, hash(bytes));
  return { state: value[kind], bytes };
}

test('independent PostgreSQL stores serialize timer cancellations and publish the complete winning source', {
  skip: !postgresTestConnectionString,
}, async t => {
  const source = '[{"Id":"first","SeriesTimerId":"series-a","Status":"New","IsManual":false},'
    + '{"Id":"second","SeriesTimerId":"series-b","Status":"New","IsManual":false},'
    + '{"Id":"untouched","SeriesTimerId":"series-c","Status":"New","Opaque":{"value":1}}]';
  const fixture = await timerFixture(t, 'live_tv_timer_serial', {
    timers: source,
  });
  const initial = await savedState(fixture.primaryDatabase);
  const firstId = initial.value.timers.rows[0].internalId;
  const secondId = initial.value.timers.rows[1].internalId;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const blocker = fixture.primaryStore.serializeWrites(async () => {
    entered.resolve();
    await release.promise;
  });
  let first, second;
  let firstSettled = false, secondSettled = false;
  try {
    await bounded(entered.promise);
    first = fixture.primaryService.cancelTimer(firstId);
    second = fixture.secondaryService.cancelTimer(secondId);
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await setImmediate();
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false, 'the second store cannot publish while the first writer boundary is held');
    assert.equal((await readFile(fixture.timerFile)).toString(), source);
  } finally { release.resolve(); }
  await bounded(blocker);
  assert.deepEqual(await bounded(Promise.all([first, second])), [true, true]);

  const { state, bytes } = await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
  const documents = JSON.parse(bytes);
  assert.deepEqual(documents.map(timer => ({ Id: timer.Id, Status: timer.Status, IsManual: timer.IsManual })), [
    { Id: 'first', Status: 'Cancelled', IsManual: true },
    { Id: 'second', Status: 'Cancelled', IsManual: true },
    { Id: 'untouched', Status: 'New', IsManual: undefined },
  ]);
  assert.equal(documents[2].Opaque.value, 1);
  assert.equal(state.rows.length, 3);
  await assertSourceMatchesFile(fixture.secondaryDatabase, 'seriesTimers', fixture.seriesFile);
  assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
});

test('a deferred PostgreSQL failure rolls back after file publication and restores the authoritative bytes', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_rollback', {
    timers: '[{"Id":"rollback","SeriesTimerId":"series","Status":"New","IsManual":false}]',
  });
  const before = await savedState(fixture.primaryDatabase);
  const timerBefore = await readFile(fixture.timerFile), seriesBefore = await readFile(fixture.seriesFile);
  const control = q(fixture.primaryDatabase.controlSchema);
  let functionCreated = false, triggerCreated = false;
  try {
    await fixture.primaryDatabase.client.query(`CREATE FUNCTION ${control}.fail_live_tv_timer_commit()
      RETURNS trigger LANGUAGE plpgsql AS $live_tv_timer_test$
      BEGIN
        IF NEW.key = 'liveTvNativeState' THEN
          RAISE EXCEPTION 'Controlled Live TV deferred rollback.';
        END IF;
        RETURN NEW;
      END;
      $live_tv_timer_test$`);
    functionCreated = true;
    await fixture.primaryDatabase.client.query(`CREATE CONSTRAINT TRIGGER fail_live_tv_timer_commit
      AFTER UPDATE ON ${control}.state DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${control}.fail_live_tv_timer_commit()`);
    triggerCreated = true;

    await assert.rejects(fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId),
      /Controlled Live TV deferred rollback/u);
    assert.equal((await savedState(fixture.primaryDatabase)).raw, before.raw);
    assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    assert.deepEqual(await readFile(fixture.seriesFile), seriesBefore);
    await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
    await assertSourceMatchesFile(fixture.primaryDatabase, 'seriesTimers', fixture.seriesFile);
    assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
  } finally {
    const cleanupErrors = [];
    if (triggerCreated) try {
      await fixture.primaryDatabase.client.query(`DROP TRIGGER fail_live_tv_timer_commit ON ${control}.state`);
    } catch (error) { cleanupErrors.push(error); }
    if (functionCreated) try {
      await fixture.primaryDatabase.client.query(`DROP FUNCTION ${control}.fail_live_tv_timer_commit()`);
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Deferred Live TV rollback fixture cleanup failed.');
  }
});

test('close drains an admitted cancellation waiting on another PostgreSQL writer and rejects later admission', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_close', {
    timers: '[{"Id":"closing","SeriesTimerId":"series","Status":"New"}]',
  });
  const before = await savedState(fixture.primaryDatabase);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const blocker = fixture.primaryStore.serializeWrites(async () => {
    entered.resolve();
    await release.promise;
  });
  let cancellation, closing;
  let cancellationSettled = false, closeSettled = false;
  try {
    await bounded(entered.promise);
    cancellation = fixture.secondaryService.cancelTimer(before.value.timers.rows[0].internalId);
    closing = fixture.secondaryService.close();
    void cancellation.then(() => { cancellationSettled = true; }, () => { cancellationSettled = true; });
    void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await setImmediate();
    assert.equal(cancellationSettled, false);
    assert.equal(closeSettled, false, 'close must retain the admitted operation until its writer boundary completes');
    await assert.rejects(fixture.secondaryService.cancelTimer(before.value.timers.rows[0].internalId), { status: 503 });
  } finally { release.resolve(); }
  await bounded(blocker);
  assert.equal(await bounded(cancellation), true);
  await bounded(closing);
  const { bytes } = await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
  assert.deepEqual(JSON.parse(bytes), [
    { Id: 'closing', SeriesTimerId: 'series', Status: 'Cancelled', IsManual: true },
  ]);
});

test('idempotent cancellation preserves staging failures, closes the actual file and recovers on the next operation', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_noop_failure', {
    timers: '[{"Id":"cancelled","SeriesTimerId":"series","Status":"Cancelled","IsManual":true}]',
  });
  const before = await savedState(fixture.primaryDatabase), timerBefore = await readFile(fixture.timerFile);
  const requested = before.value.timers.rows[0].internalId;
  for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined],
    ['errno', Object.assign(new Error('Controlled timer staging write failure.'), { code: 'ENOSPC', statusCode: 507 })]]) {
    await t.test(name, async () => {
      const handles = [], removed = [];
      fixture.primaryService.stateFileSystem = { ...fs,
        async open(filename, flags) {
          const handle = await fs.open(filename, flags); handles.push(handle);
          return { async writeFile(bytes) {
            await handle.writeFile(bytes.subarray(0, 7));
            throw reason;
          }, close: () => handle.close() };
        },
        async rm(filename, options) { await fs.rm(filename, options); removed.push(filename); },
      };
      try {
        await assert.rejects(fixture.primaryService.cancelTimer(requested), error => Object.is(error, reason));
        assert.equal(handles.length, 1); assert.equal(removed.length, 1);
        await assert.rejects(handles[0].stat(), { code: 'EBADF' });
        assert.deepEqual((await savedState(fixture.primaryDatabase)).value, before.value);
        assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
        assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
      } finally { fixture.primaryService.stateFileSystem = fs; }
      assert.equal(await fixture.primaryService.cancelTimer(requested), true);
      await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
      assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    });
  }
});

test('timer staging reports write, close and removal failures in order after actual cleanup without poisoning PostgreSQL', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_cleanup_failure', {
    timers: '[{"Id":"cleanup","SeriesTimerId":"series","Status":"New"}]',
  });
  const before = await savedState(fixture.primaryDatabase), timerBefore = await readFile(fixture.timerFile);
  const primary = Object.assign(new Error('Controlled timer partial write failure.'), { code: 'ENOSPC', status: 507 });
  const closeFailure = { operation: 'close' }, removeFailure = 0, handles = [], order = [];
  fixture.primaryService.stateFileSystem = { ...fs,
    async open(filename, flags) {
      const handle = await fs.open(filename, flags); handles.push(handle);
      return { async writeFile(bytes) { await handle.writeFile(bytes.subarray(0, 11)); order.push('write'); throw primary; },
        async close() { await handle.close(); order.push('close'); throw closeFailure; } };
    },
    async rm(filename, options) { await fs.rm(filename, options); order.push('remove'); throw removeFailure; },
  };
  try {
    await assert.rejects(fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId), failure => {
      assert.ok(failure instanceof AggregateError); assert.equal(failure.cause, primary);
      assert.deepEqual(failure.errors, [primary, closeFailure, removeFailure]);
      assert.equal(failure.code, 'ENOSPC'); assert.equal(failure.status, 507); return true;
    });
    assert.deepEqual(order, ['write', 'close', 'remove']);
    assert.equal(handles.length, 1); await assert.rejects(handles[0].stat(), { code: 'EBADF' });
    assert.deepEqual((await savedState(fixture.primaryDatabase)).value, before.value);
    assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
  } finally { fixture.primaryService.stateFileSystem = fs; }
  assert.equal(await fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId), true);
  await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
});
