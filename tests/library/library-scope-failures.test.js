import test from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { inspect, isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { ChannelService } from '../../src/library/channel-service.js';
import { idKey } from '../../src/library/records.js';
import { nativeYearIdentity } from '../../src/library/year-identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { readTestLinkIds } from './collection-test-consumers.js';

export const requiredValidationServices = ['postgres'];
const id = value => `9f790000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const deferred = () => Promise.withResolvers();
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
const fileObservation = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
const snapshot = async database => Object.fromEntries(await Promise.all(nativeModel.tables.map(async table => [table.name,
  await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])));

// Preserve own undefined causes and business name/stack fields. Diagnostic
// getters are described without invoking them or replacing the actual reason.
function functional(value) {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const properties = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (value instanceof Error && ['name', 'stack'].includes(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    properties[name] = Object.hasOwn(descriptor, 'value') ? functional(descriptor.value)
      : { accessor: true, get: typeof descriptor.get === 'function', set: typeof descriptor.set === 'function' };
  }
  return { kind: value instanceof AggregateError ? 'AggregateError' : value instanceof Error ? 'Error' : 'Object', properties };
}
function raw(value) {
  try { return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false, getters: false }); }
  catch { return inspect(functional(value), { depth: null, maxArrayLength: null, maxStringLength: null }); }
}
const observation = reason => ({ type: typeof reason, ownCause: reason != null && Object.hasOwn(reason, 'cause'), functional: functional(reason), raw: raw(reason) });
function actualReasons(reason, expected) {
  const projected = functional(reason);
  if (expected.some(value => isDeepStrictEqual(projected, functional(value)))) return [projected];
  if (reason instanceof AggregateError) return reason.errors.flatMap(value => actualReasons(value, expected));
  return [projected];
}
function assertFirstCause(reason, primary) {
  while (!isDeepStrictEqual(functional(reason), functional(primary))) {
    assert.ok(reason instanceof AggregateError, 'Multiple actual failures expose the original first reason through cause.');
    assert.ok(Object.hasOwn(reason, 'cause'), 'An undefined original reason still requires an own cause property.');
    assert.deepEqual(functional(reason.cause), functional(reason.errors[0]));
    reason = reason.cause;
  }
}
async function reached(signal, settled, label) {
  await Promise.race([signal.promise, settled.then(result => {
    throw new Error('The library operation settled before ' + label + '.', { cause: result.reason });
  })]);
}

test('library scope preserves actual business and owner failures while draining PostgreSQL links, a typed callback and Local handles', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { library, store, database, linkedChildren } = fixture;
  const output = path.join(validationOutputRoot(), 'library-scope-failures-' + randomUUID());
  await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    controls: 'Real installed Local file handles, PostgreSQL native rows/link owners and production user-root frame/channel/metadata owners. Faults are injected only after the named actual owner cleanup.',
    cases: [], ownerShutdown: [], fixtureFinalCleanup: 'setupChildrenFixture t.after owns schema/directory removal after these assertions; its cleanup is not evidence of the production owner drain.' };
  await testFileSystem.mkdir(path.join(fixture.stateRoot, 'root'), { recursive: true });
  await testFileSystem.mkdir(path.join(fixture.stateRoot, 'folder'), { recursive: true });
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'UserRootFolder', Id: id(1), Name: 'Scope root', IsRoot: true,
      Path: path.join(fixture.stateRoot, 'root'), links: ['folder'] },
    { key: 'folder', type: 'Folder', Id: id(2), Name: 'Scope folder', parent: 'root',
      Path: path.join(fixture.stateRoot, 'folder') },
  ] });
  library.options.userRoot = (await database.rows('BaseItems', { where: { Id: id(1) } }))[0];
  const user = { Id: id(99), Username: 'Owner audit', Configuration: {}, Policy: { EnableAllFolders: true,
    AllowedTags: [], BlockedTags: [], BlockUnratedItems: [] } };
  const channels = new ChannelService({ plugins: { entries: () => [] }, library,
    users: { getUser: async () => user }, getMetadata: () => fixture.host });
  library.channels = channels;
  const originalFlush = linkedChildren.flushReleases, originalAdmitScope = linkedChildren.admitScope;
  const originalChannelAdmission = channels.admitOperation;
  let active, preparingFrame = false, frameScopeCaptured = false;
  linkedChildren.admitScope = function (...args) {
    const admitted = originalAdmitScope.apply(this, args), current = active;
    if (!current || !preparingFrame || frameScopeCaptured) return admitted;
    frameScopeCaptured = true;
    return Object.freeze({ ...admitted, release() {
      const result = admitted.release();
      current.events.push('frame actual scope release'); current.frameActuallyReleased = true;
      if (current.frameFault) throw current.frameReason;
      return result;
    } });
  };
  linkedChildren.flushReleases = async function (options) {
    const result = await originalFlush.call(this, options), current = active;
    if (current?.outerFlushArmed && options?.session === current.session && !current.outerFlushObserved) {
      current.outerFlushObserved = true; current.events.push('outer actual flush'); current.flushEntered.resolve();
      await current.flushGate.promise;
      if (current.flushFault) throw current.flushReason;
    }
    return result;
  };
  channels.admitOperation = function (...args) {
    const admitted = originalChannelAdmission.apply(this, args), current = active;
    if (!current) return admitted;
    return Object.freeze({ ...admitted, async release() {
      await admitted.release(); current.events.push('channel actual release'); current.channelActuallyReleased = true;
      current.channelEntered.resolve(); await current.channelGate.promise;
      if (current.channelFault) throw current.channelReason;
    } });
  };
  const structured = Object.assign(new Error('Deferred user failure.', { cause: { name: 'Business cause', stack: 'Business stack', value: undefined } }),
    { code: 'user-failure', status: 409, statusCode: 422, errors: [false, 0, '', null, undefined] });
  const business = { name: 'Business rejection', stack: 'Business stack', message: 'Deferred user rejected.',
    code: 0, status: 422, statusCode: 409, cause: undefined, errors: [false, 0, '', null, undefined] };
  const hostile = new Error();
  for (const name of ['message', 'code', 'status', 'statusCode']) Object.defineProperty(hostile, name, {
    configurable: true, get() { throw new Error('Diagnostic getter ' + name + ' must not replace the original failure.'); },
  });
  const all = { stateFault: true, frameFault: true, flushFault: true, channelFault: true };
  const scenarios = [
    ...[['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]
      .map(([name, reason]) => ({ name: name + '-all-owners', reason, ...all })),
    { name: 'false-flush', reason: false, flushFault: true },
    { name: 'undefined-channel', reason: undefined, channelFault: true },
    { name: 'structured-error', reason: structured, stateFault: true, flushFault: true, channelFault: true },
    { name: 'business-object', reason: business, stateFault: true, flushFault: true, channelFault: true },
    { name: 'throwing-diagnostics', reason: hostile, stateFault: true, flushFault: true, channelFault: true },
    { name: 'successful-query-all-owners', succeeds: true, ...all },
    { name: 'successful-query-false-flush', succeeds: true, flushFault: true, singleReason: false },
    { name: 'successful-query-undefined-channel', succeeds: true, channelFault: true, singleReason: undefined },
  ];
  try {
    for (const [index, scenario] of scenarios.entries()) await t.test(scenario.name, async () => {
      const current = { ...scenario, stateReason: 0, frameReason: null,
        flushReason: Object.assign(new Error('Actual link flush finished before this controlled rejection.', { cause: undefined }),
          { code: 'scope-flush', status: 507, statusCode: 503, errors: [false, 0, '', null, undefined] }),
        channelReason: Object.assign(new Error('Actual channel release finished before this controlled rejection.', { cause: 0 }),
          { code: 'channel-release', status: 502, statusCode: 500 }),
        stateEntered: deferred(), stateGate: deferred(), secondStateReleased: deferred(), callbackEntered: deferred(), callbackGate: deferred(),
        flushEntered: deferred(), flushGate: deferred(), channelEntered: deferred(), channelGate: deferred(), events: [] };
      if (scenario.succeeds && scenario.flushFault && Object.hasOwn(scenario, 'singleReason')) current.flushReason = scenario.singleReason;
      if (scenario.succeeds && scenario.channelFault && Object.hasOwn(scenario, 'singleReason')) current.channelReason = scenario.singleReason;
      active = current; frameScopeCaptured = false;
      const year = 2080 + index, identity = nativeYearIdentity(String(year), library.options);
      const source = path.join(fixture.stateRoot, 'scope-source-' + index + '.bin');
      const witness = path.join(fixture.stateRoot, 'scope-prefix-' + index + '.bin');
      const sourceBytes = Buffer.from('Original source\0' + scenario.name + '\n', 'utf8');
      const prefix = Buffer.from('Committed Local prefix\0' + scenario.name + '\n', 'utf8');
      const oldTarget = Buffer.from('Preexisting Local target\n', 'utf8');
      await testFileSystem.writeFile(source, sourceBytes); await testFileSystem.writeFile(witness, oldTarget);
      const record = { name: scenario.name, businessFailure: !scenario.succeeds, input: observation(scenario.reason),
        before: await snapshot(database), events: current.events,
        local: { source: fileObservation(sourceBytes), beforeTarget: fileObservation(oldTarget), prefix: fileObservation(prefix) } };
      report.cases.push(record);
      let file, fileClosed = false, frame, held, operation, settled = false;
      try {
        operation = outcome(library.getYearDto(year, { resolveUser: async () => {
          try {
          const rows = await database.rows('BaseItems', { where: { Id: identity.Id } });
          assert.equal(rows.length, 1); assert.equal(rows[0].Name, String(year));
          assert.equal((await testFileSystem.stat(identity.Path)).isDirectory(), true);
          await store.run(async session => {
            current.session = session;
            record.backend = (await session.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
            const rootRows = await session.rows('BaseItems', { where: { Id: id(1) } });
            const state = await library.load(session, null, { baseRows: rootRows, includeFolderLinks: true, includeUserData: false });
            record.links = await readTestLinkIds(state.byId.get(idKey(id(1))));
            assert.deepEqual(record.links, [idKey(id(2))]);
            const secondState = await library.load(session, null, { baseRows: rootRows, includeFolderLinks: true, includeUserData: false });
            const disposeSecond = secondState.dispose.bind(secondState);
            secondState.dispose = async options => {
              try { await disposeSecond(options); current.events.push('second state actual release'); }
              finally { current.outerFlushArmed = true; current.secondStateReleased.resolve(); }
            };
            preparingFrame = true;
            try { await library.navigationChildren(state, user); }
            finally { preparingFrame = false; }
            frame = state.rootNavigation.frame;
            held = frame.withPage({ limit: 1 }, async ({ entries }) => {
              assert.equal(entries.length, 1); assert.equal(idKey(entries[0].item.Id), idKey(id(2)));
              current.callbackEntered.resolve(); await current.callbackGate.promise;
              assert.equal(entries[0].item.Name, 'Scope folder'); current.events.push('typed callback completed');
              return entries.map(entry => idKey(entry.item.Id));
            });
            // Attach immediately; a failed fixture setup cannot create an
            // unobserved rejection while the production owner is closing.
            void held.catch(() => {});
            await reached(current.callbackEntered, outcome(held), 'the admitted typed callback');
            file = await testFileSystem.open(witness, 'w+'); current.fd = file.fd;
            await file.writeFile(prefix); await file.sync();
            assert.equal(fstatSync(current.fd).isFile(), true);
            assert.deepEqual(await testFileSystem.readFile(witness), prefix);
            const dispose = state.dispose.bind(state);
            state.dispose = async options => {
              const failures = [];
              try { await dispose(options); current.events.push('first state actual release'); } catch (error) { failures.push(error); }
              current.stateEntered.resolve(); await current.stateGate.promise;
              try {
                await file.close(); fileClosed = true;
                assert.throws(() => fstatSync(current.fd), { code: 'EBADF' });
                current.events.push('Local actual fd close');
              } catch (error) { failures.push(error); }
              if (current.stateFault) failures.push(current.stateReason);
              if (failures.length === 1) throw failures[0];
              if (failures.length > 1) throw new AggregateError(failures, 'Controlled state cleanup also failed.');
            };
            record.committedPrefix = await snapshot(session);
            assert.deepEqual(await testFileSystem.readFile(source), sourceBytes);
            assert.deepEqual(await testFileSystem.readFile(witness), prefix);
          });
          } catch (error) {
            for (const gate of ['stateGate', 'callbackGate', 'flushGate', 'channelGate']) current[gate].resolve();
            throw error;
          }
          current.events.push(scenario.succeeds ? 'deferred user completed' : 'deferred user rejected');
          if (!scenario.succeeds) throw scenario.reason;
          return null;
        } })).then(result => { settled = true; return result; });
        await reached(current.stateEntered, operation, 'the actual state cleanup');
        assert.equal(settled, false); assert.equal(fstatSync(current.fd).isFile(), true);
        record.pendingWithOpenLocalHandle = true; current.stateGate.resolve();
        await reached(current.secondStateReleased, operation, 'the second actual state release');
        // Let frame.close reach its pending production callback; this is a
        // scheduling turn, not a delay or polling loop.
        await new Promise(setImmediate);
        assert.equal(settled, false); assert.equal(fileClosed, true);
        assert.throws(() => frame.orderedPlan(), { message: 'The user-root navigation frame has been closed.' });
        record.pendingWithAdmittedTypedCallback = true; current.callbackGate.resolve();
        assert.deepEqual(await held, [idKey(id(2))]);
        await reached(current.flushEntered, operation, 'the final actual link flush');
        assert.equal(settled, false); assert.equal(current.frameActuallyReleased, true);
        record.pendingAfterActualFrameDrain = true; current.flushGate.resolve();
        await reached(current.channelEntered, operation, 'the actual channel release');
        assert.equal(settled, false); assert.equal(current.session.connectionActive, false);
        assert.equal(current.session.connectionReleaseError, null); assert.equal(current.channelActuallyReleased, true);
        record.pendingAfterActualChannelDrain = true; current.channelGate.resolve();
        const result = await operation;
        assert.equal(result.failed, true); record.delivered = observation(result.reason);
        const reasons = [...(!scenario.succeeds ? [scenario.reason] : []),
          ...(current.stateFault ? [current.stateReason] : []), ...(current.frameFault ? [current.frameReason] : []),
          ...(current.flushFault ? [current.flushReason] : []), ...(current.channelFault ? [current.channelReason] : [])];
        assert.deepEqual(actualReasons(result.reason, reasons), reasons.map(functional),
          'Every actual failure remains present in operation, state, frame, flush, channel order.');
        if (reasons.length === 1) assert.ok(Object.is(result.reason, reasons[0]), 'A single actual failure remains the original raw reason.');
        else {
          assertFirstCause(result.reason, reasons[0]);
          for (const name of ['code', 'status', 'statusCode']) {
            const original = Object.getOwnPropertyDescriptor(scenario.reason ?? {}, name);
            if (original && Object.hasOwn(original, 'value')) assert.deepEqual(result.reason[name], original.value);
          }
        }
        record.afterFailure = await snapshot(database);
        assert.deepEqual(record.afterFailure, record.committedPrefix, 'Owner failures cannot roll back the already committed Year prefix or alter native tables.');
        assert.deepEqual(await testFileSystem.readFile(source), sourceBytes);
        assert.deepEqual(await testFileSystem.readFile(witness), prefix);
        await writeFile(path.join(output, scenario.name + '-prefix.bin'), await testFileSystem.readFile(witness), { flag: 'wx' });
        active = undefined;
        const recovered = await library.getYearDto(year, { resolveUser: async () => null });
        assert.equal(recovered.Id, idKey(identity.Id)); assert.equal(recovered.Name, String(year)); assert.equal(recovered.Type, 'Year');
        await store.run(async session => {
          const state = await library.load(session, null, { baseRows: await session.rows('BaseItems', { where: { Id: id(1) } }),
            includeFolderLinks: true, includeUserData: false });
          try {
            record.recoveredLinks = await readTestLinkIds(state.byId.get(idKey(id(1))));
            assert.deepEqual(record.recoveredLinks, [idKey(id(2))]);
          } finally { await state.dispose({ session }); }
        });
        record.afterRecovery = await snapshot(database); assert.deepEqual(record.afterRecovery, record.committedPrefix);
        record.recoveredDto = recovered;
      } catch (error) {
        record.assertionFailure = observation(error); throw error;
      } finally {
        preparingFrame = false;
        for (const gate of ['stateGate', 'callbackGate', 'flushGate', 'channelGate']) current[gate].resolve();
        if (held) await held.catch(() => {});
        if (operation) await operation;
        active = undefined;
        if (file && !fileClosed) {
          record.fixtureFallbackFileClose = true; await file.close();
        }
        await writeFile(path.join(output, scenario.name + '-error.txt'), record.delivered?.raw ?? 'No delivered failure was recorded.\n');
        await writeFile(path.join(output, 'report.json'), json(report));
      }
    });
    // These are explicit normal owner closes, before setupChildrenFixture's
    // t.after teardown. Runtime schema absence proves the real owner drained.
    active = undefined;
    const closeFailures = [];
    for (const [name, close] of [['channels', () => channels.close()], ['metadata', () => fixture.host.close()],
      ['item creation', () => library.itemCreation.close()], ['library', () => library.close()],
      ['owned releases', () => linkedChildren.flushOwnedReleases()], ['linked runtime', () => linkedChildren.close()]]) {
      try { await close(); report.ownerShutdown.push({ owner: name, closed: true }); }
      catch (error) { closeFailures.push(error); report.ownerShutdown.push({ owner: name, failure: observation(error) }); }
    }
    if (closeFailures.length) throw new AggregateError(closeFailures, 'The actual production owners failed to drain.');
    report.runtimeAfterOwnerClose = (await database.client.query('SELECT to_regnamespace($1)::text AS namespace', [linkedChildren.schemaName])).rows;
    assert.deepEqual(report.runtimeAfterOwnerClose, [{ namespace: null }]);
    assert.deepEqual((await database.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
  } finally {
    active = undefined; preparingFrame = false;
    channels.admitOperation = originalChannelAdmission;
    linkedChildren.admitScope = originalAdmitScope; linkedChildren.flushReleases = originalFlush;
    await channels.close();
    await writeFile(path.join(output, 'report.json'), json(report));
  }
});
