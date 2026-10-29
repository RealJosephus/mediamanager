import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataRegistry, MetadataSaveHost } from '../../src/metadata/index.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const original = Buffer.from('Original metadata bytes.\n');
const primaryMessage = 'The metadata context loader must return item, context, libraryOptions, and exists.';
const functionalError = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functionalError);
  return Object.fromEntries(Object.getOwnPropertyNames(value).filter(key => !(value instanceof Error) || !['name', 'stack'].includes(key))
    .map(key => [key, functionalError(value[key])]));
};

async function rejected(operation) {
  try { await operation(); } catch (error) { return error; }
  assert.fail('The metadata operation must reject.');
}

function combined(error, primary, cleanup) {
  assert.deepEqual(functionalError(error), {
    message: primary?.message ?? 'Metadata saving and context cleanup failed.',
    cause: functionalError(primary), errors: [functionalError(primary), functionalError(cleanup)],
    ...Object.fromEntries(['code', 'status', 'statusCode'].filter(key => primary?.[key] !== undefined).map(key => [key, primary[key]])),
  });
}

async function fixture(t) {
  const root = path.join(validationOutputRoot(), 'save-host-failures-' + randomUUID());
  await mkdir(root, { recursive: true });
  const database = await createPostgresTestDatabase(null, 'save_host_fail');
  const registry = new MetadataRegistry(), events = new EventEmitter(), logs = [], owners = [];
  const report = { scope: 'MetadataSaveHost with real PostgreSQL transactions, temporary relations and Local storage file handles.',
    cases: [], phaseAcceptance: false, releaseAcceptance: false, cleanup: {} };
  let configuration = {};
  const loadContext = async reference => {
    const selected = { ...configuration }, filename = path.join(root, reference.Id + '.nfo');
    const temporary = 'save_context_' + randomUUID().replaceAll('-', '');
    const owner = { filename, temporary, key: reference.Id, selected, connection: undefined, file: undefined,
      fileReleased: false, connectionReleased: false, cleanupFailure: undefined };
    owners.push(owner);
    await testFileSystem.writeFile(filename, original);
    owner.file = await testFileSystem.open(filename, 'r');
    owner.connection = await database.pool.connect();
    await owner.connection.query(`CREATE TEMP TABLE ${quoteIdentifier(temporary)} (id integer PRIMARY KEY)`);
    owner.oid = (await owner.connection.query('SELECT to_regclass($1)::oid AS oid', ['pg_temp.' + temporary])).rows[0].oid;
    owner.release = async (inject = false) => {
      const failures = [];
      if (!owner.connectionReleased) {
        let discard;
        try { await owner.connection.query(`DROP TABLE ${quoteIdentifier(inject && selected.sqlCleanupFailure ? temporary + '_missing' : temporary)}`); }
        catch (error) { discard = error; failures.push(error); }
        if (discard) try { await owner.connection.end(); } catch (error) { failures.push(error); }
        try { owner.connection.release(discard); owner.connectionReleased = true; } catch (error) { failures.push(error); }
      }
      if (!owner.fileReleased) try { await owner.file.close(); owner.fileReleased = true; } catch (error) { failures.push(error); }
      if (failures.length) {
        owner.cleanupFailure = failures.length === 1 ? failures[0]
          : new AggregateError(failures, 'Metadata fixture resource release failed.', { cause: failures[0] });
        throw owner.cleanupFailure;
      }
    };
    const loaded = { item: { Id: reference.Id, Type: 'BoxSet', Path: filename, IsFileProtocol: true,
      DateLastSaved: '2020-01-01T00:00:00Z' }, libraryOptions: { MetadataSavers: ['First', 'Second'] },
      exists: async target => { try { await testFileSystem.stat(target); return true; } catch (error) { if (error.code === 'not-found') return false; throw error; } },
      context: { filename, key: reference.Id, selected }, async dispose() {
        await owner.release(true);
        if (Object.hasOwn(selected, 'cleanupReason')) { owner.cleanupFailure = selected.cleanupReason; throw selected.cleanupReason; }
      } };
    owner.loaded = loaded;
    if (selected.invalid) delete loaded.exists;
    return loaded;
  };
  const host = new MetadataSaveHost({ registry, loadContext, now: () => '2026-10-26T08:00:00Z',
    logger: { error: error => logs.push(error) } });
  t.after(async () => {
    const failures = [];
    try { await host.dispose(); report.cleanup.hostDrained = true; } catch (error) { failures.push(error); }
    for (const owner of owners) {
      try {
        if (owner.release) await owner.release();
        else {
          if (owner.connection) { await owner.connection.end(); owner.connection.release(new Error('Context acquisition did not complete.')); }
          await owner.file?.close();
        }
      } catch (error) { failures.push(error); }
    }
    try { await dropPostgresTestDatabase(database); report.cleanup.schemasRemoved = true; } catch (error) { failures.push(error); }
    report.cleanupErrors = failures.map(error => errorObservation(error));
    try { await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Metadata failure fixture cleanup failed.', { cause: failures[0] });
  });
  return { database, registry, host, logs, owners, events, report,
    configure(value) { configuration = value; },
    async released(owner) {
      const deadline = performance.now() + 5000;
      for (;;) {
        const rows = (await database.client.query('SELECT oid FROM pg_class WHERE oid = $1::oid', [owner.oid])).rows;
        if (!rows.length) break;
        assert.ok(performance.now() < deadline, 'The real temporary relation must disappear after owner disposal.');
        await delay(10);
      }
      await assert.rejects(async () => owner.file.stat(), { code: 'closed' });
      assert.equal((await database.client.query('SELECT 1 AS value')).rows[0].value, 1);
    },
  };
}

async function committedPrefix(database, { filename, key }, content) {
  await testFileSystem.writeFile(filename, Buffer.from(content));
  await database.setState(key + '-prefix', content);
}

async function rollbackFailure(database, key, reason) {
  await database.transaction(async transaction => {
    await transaction.setState(key + '-uncommitted', 'This value must roll back.');
    throw reason;
  });
}

test('metadata user events retain primitive business failures with actual SQL cleanup failure and release their file and relation owners', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const state = await fixture(t);
  state.registry.register({ id: 'event', name: 'Event', providers: [], async onUserDataSaved(event) {
    const owner = state.owners.at(-1), context = owner.loaded.context;
    await committedPrefix(state.database, context, 'Committed metadata for ' + event.Item.Id);
    if (context.selected.fail) await rollbackFailure(state.database, context.key, context.selected.reason);
    else await state.database.setState(context.key + '-recovered', 'Committed recovery.');
  } });
  state.host.start(state.events);
  const reasons = [false, 0, '', null, undefined,
    Object.assign(new Error('The metadata event failed after its committed prefix.', { cause: null }),
      { code: '23514', status: 409, statusCode: 409, errors: [false, null] })];
  for (const [index, reason] of reasons.entries()) {
    const key = 'event-' + index, content = 'Committed metadata for ' + key;
    state.configure({ fail: true, reason, sqlCleanupFailure: true });
    const before = state.logs.length;
    state.events.emit('UserDataSaved', { Item: { Id: key } });
    await state.host.drain();
    const owner = state.owners.at(-1), observed = state.logs.slice(before);
    const error = observed.find(value => Array.isArray(value?.errors) && value.errors.some(entry => entry?.code === '42P01'));
    assert.ok(error, 'The original event and real SQL disposal failure must reach the existing event logger.');
    assert.equal(owner.cleanupFailure.code, '42P01');
    combined(error, reason, owner.cleanupFailure);
    assert.deepEqual(await readFile(owner.filename), Buffer.from(content));
    assert.equal(await state.database.getState(key + '-prefix'), content);
    assert.equal(await state.database.getState(key + '-uncommitted'), undefined);
    await state.released(owner);
    state.report.cases.push({ key, type: typeof reason, reason: errorObservation(reason), error: errorObservation(error),
      prefix: await state.database.getState(key + '-prefix'), rollback: true, resourcesReleased: true });
  }
  state.configure({});
  state.events.emit('UserDataSaved', { Item: { Id: 'event-recovery' } });
  await state.host.drain();
  assert.equal(await state.database.getState('event-recovery-recovered'), 'Committed recovery.');
  await state.released(state.owners.at(-1));
});

test('manual metadata saving keeps best-effort saver failures and committed successors when context disposal rejects with primitive reasons', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const state = await fixture(t);
  const business = Object.assign(new Error('The first saver failed inside its PostgreSQL transaction.'), { code: '23514', status: 409 });
  state.registry.register({ id: 'manual', name: 'Manual', providers: [
    { id: 'first', name: 'First', kind: 'saver', itemTypes: ['BoxSet'], isEnabledFor: () => true,
      async save(_item, context) {
        await committedPrefix(state.database, context, 'First saver prefix for ' + context.key);
        await rollbackFailure(state.database, context.key, business);
      } },
    { id: 'second', name: 'Second', kind: 'saver', itemTypes: ['BoxSet'], isEnabledFor: () => true,
      async save(_item, context) {
        await testFileSystem.writeFile(context.filename + '.saved', Buffer.from('Second saver committed.'));
        await state.database.setState(context.key + '-saved', 'Second saver committed.');
        return { saved: true };
      } },
  ] });
  for (const [index, reason] of [false, 0, '', null, undefined].entries()) {
    const key = 'manual-' + index;
    state.configure({ cleanupReason: reason });
    const before = state.logs.length;
    const error = await rejected(() => state.host.save({ Id: key }, 'MetadataEdit'));
    assert.ok(Object.is(error, reason));
    const owner = state.owners.at(-1);
    const logged = state.logs.slice(before).find(value => value?.code === business.code && value?.message === business.message);
    assert.ok(logged); assert.deepEqual(functionalError(logged), functionalError(business));
    assert.deepEqual(await readFile(owner.filename), Buffer.from('First saver prefix for ' + key));
    assert.deepEqual(await readFile(owner.filename + '.saved'), Buffer.from('Second saver committed.'));
    assert.equal(await state.database.getState(key + '-uncommitted'), undefined);
    assert.equal(await state.database.getState(key + '-saved'), 'Second saver committed.');
    assert.equal(owner.loaded.item.DateLastSaved, '2026-10-26T08:00:00Z');
    await state.released(owner);
    state.report.cases.push({ key, type: typeof reason, reason: errorObservation(error),
      prefixRetained: true, failedSaverRolledBack: true, successorCommitted: true, resourcesReleased: true });
  }
  state.configure({});
  const outcomes = await state.host.save({ Id: 'manual-recovery' }, 'MetadataEdit');
  assert.deepEqual(functionalError(outcomes), [{ saver: 'first', error: functionalError(business) }, { saver: 'second', result: { saved: true } }]);
  await state.released(state.owners.at(-1));
});

test('invalid metadata contexts release already-acquired PostgreSQL and Local file resources in manual and subscribed entry points', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const state = await fixture(t);
  state.registry.register({ id: 'invalid', name: 'Invalid', providers: [], async onUserDataSaved(event) {
    await state.database.setState(event.Item.Id + '-invoked', 'The valid event ran.');
  } });
  state.host.start(state.events);
  for (const mode of ['manual', 'event']) {
    const key = 'invalid-' + mode;
    state.configure({ invalid: true, sqlCleanupFailure: true });
    const before = state.logs.length;
    let error;
    if (mode === 'manual') error = await rejected(() => state.host.save({ Id: key }, 'MetadataEdit'));
    else {
      state.events.emit('UserDataSaved', { Item: { Id: key } });
      await state.host.drain();
      error = state.logs.slice(before).find(value => value?.cause?.message === primaryMessage);
    }
    assert.ok(error); assert.equal(error.cause.message, primaryMessage);
    const owner = state.owners.at(-1);
    combined(error, new TypeError(primaryMessage), owner.cleanupFailure);
    assert.equal(owner.cleanupFailure.code, '42P01');
    assert.deepEqual(await readFile(owner.filename), original);
    assert.equal(await state.database.getState(key + '-invoked'), undefined);
    await state.released(owner);
    state.report.cases.push({ mode, error: errorObservation(error), unchangedFile: true, resourcesReleased: true });
  }
  state.configure({});
  state.events.emit('UserDataSaved', { Item: { Id: 'invalid-recovery' } });
  await state.host.drain();
  assert.equal(await state.database.getState('invalid-recovery-invoked'), 'The valid event ran.');
  await state.released(state.owners.at(-1));
});
