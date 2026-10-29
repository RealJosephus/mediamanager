import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { inspect } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { MIN_DATE, dateTicks, sameId } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const ownerId = 'a6f40000-0000-0000-0000-000000000001';
const childId = 'a6f40000-0000-0000-0000-000000000002';
const versionId = 'a6f40000-0000-0000-0000-000000000003';
const mediaPath = 'Z:\\ChildrenMetadata\\Refresh.mkv';
const refreshedAt = '2026-10-26T12:00:00.0000000Z';
const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const originalBytes = Buffer.from('Original refresh context bytes.\n');
const functionalError = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functionalError);
  const keys = value instanceof Error ? [...new Set(['message', ...Object.getOwnPropertyNames(value)])].filter(key => !['name', 'stack'].includes(key))
    : Object.getOwnPropertyNames(value);
  return Object.fromEntries(keys
    .map(key => [key, functionalError(value[key])]));
};
const leaves = value => Array.isArray(value?.errors) ? value.errors.flatMap(leaves) : [value];

async function rejected(operation) {
  let failed = false, reason;
  try { await operation(); } catch (error) { failed = true; reason = error; }
  assert.equal(failed, true, 'The refresh boundary must reject.');
  return reason;
}

function combined(error, expected) {
  assert.equal(Object.hasOwn(error, 'cause'), true);
  assert.deepEqual(functionalError(error.cause), functionalError(expected[0]), 'The primary reason remains complete, including undefined.');
  assert.deepEqual(functionalError(error.errors), expected.map(functionalError));
  for (const key of ['code', 'status', 'statusCode']) assert.equal(error[key], expected[0]?.[key]);
}

async function fixture(t) {
  const current = await setupChildrenFixture(t);
  await current.adapter.mkdir('/aggregate');
  for (const filename of ['Refresh.mkv', 'Refresh-part.mkv']) {
    await current.adapter.write('/aggregate/' + filename, Buffer.from('Controlled media bytes.'), { modified: '2026-10-04T12:00:00Z' });
  }
  const output = path.join(validationOutputRoot(), 'refresh-host-failures-' + randomUUID());
  await mkdir(output, { recursive: true });
  const owners = [], resources = [], logs = [];
  const report = { scope: 'MetadataRefreshHost with authoritative PostgreSQL contexts, actual Local file handles and independently owned PostgreSQL temporary relations.',
    cases: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  let action = {}, finalResource;

  const acquire = async label => {
    const key = randomUUID().replaceAll('-', ''), filename = path.join(output, key + '.nfo');
    const resource = { label, filename, temporary: 'refresh_context_' + key, fileReleased: false, connectionReleased: false, verified: false };
    resources.push(resource);
    await testFileSystem.writeFile(filename, originalBytes);
    resource.file = await testFileSystem.open(filename, 'r');
    resource.fd = resource.file.fd;
    assert.equal(fstatSync(resource.fd).isFile(), true);
    resource.connection = await current.database.pool.connect();
    await resource.connection.query(`CREATE TEMP TABLE ${quoteIdentifier(resource.temporary)} (id integer PRIMARY KEY)`);
    const row = (await resource.connection.query('SELECT to_regclass($1)::oid AS oid, pg_backend_pid() AS pid', ['pg_temp.' + resource.temporary])).rows[0];
    resource.oid = row.oid; resource.pid = row.pid;
    resource.release = async (failure) => {
      const errors = [];
      if (!resource.connectionReleased) {
        if (failure) try {
          if (failure === 'missing-table') await resource.connection.query(`DROP TABLE ${quoteIdentifier(resource.temporary + '_missing')}`);
          else await resource.connection.query('SELECT 1 / 0');
        } catch (error) { errors.push(error); resource.cleanupFailure = error; }
        try { await resource.connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(resource.temporary)}`); } catch (error) { errors.push(error); }
        try { await resource.connection.end(); } catch (error) { errors.push(error); }
        try { resource.connection.release(true); resource.connectionReleased = true; } catch (error) { errors.push(error); }
      }
      if (!resource.fileReleased) try {
        await resource.file.close(); resource.fileReleased = true;
        let fdFailure;
        try { fstatSync(resource.fd); } catch (error) { fdFailure = error; }
        resource.fdObservation = errorObservation(fdFailure);
        assert.equal(fdFailure?.code, 'EBADF', 'The captured descriptor closes in this resource lifecycle.');
        resource.fdReleased = true;
      } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Refresh fixture resource release failed.', { cause: errors[0] });
    };
    return resource;
  };

  const loadOriginal = current.loadContext;
  const loadContext = Object.assign(async (...args) => {
    const reference = typeof args[0] === 'string' ? args[0] : args[0].Id;
    const selected = action;
    if (selected.rejectLoad && sameId(reference, selected.rejectLoad)) throw selected.loadReason;
    const loaded = await loadOriginal(...args), dispose = loaded.dispose.bind(loaded);
    const resource = await acquire('context for ' + reference);
    const owner = { loaded, resource, selected: selected.cleanupFor?.(loaded) ?? {}, disposed: false };
    owners.push(owner);
    if (selected.lookupFailure && sameId(reference, ownerId)) loaded.getLocalAlternateVersionIds = async () => current.database.client.query('SELECT 1 / 0');
    if (selected.previewParts) {
      if (sameId(reference, childId)) loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Preview writer'] };
      if (sameId(reference, ownerId)) {
        loaded.supportsOwnedItems = () => true;
        loaded.searchesContainingFolderForExtras = () => false;
        loaded.previewOwnedPartContexts = async () => [await loadContext(childId), await loadContext(versionId)];
      }
    }
    let disposal;
    loaded.dispose = () => disposal ??= (async () => {
      const errors = [];
      try { await dispose(); owner.disposed = true; } catch (error) { errors.push(error); }
      try { await resource.release(owner.selected.sqlFailure); } catch (error) { errors.push(error); }
      if (Object.hasOwn(owner.selected, 'reason')) errors.push(owner.selected.reason);
      if (errors.length) {
        owner.cleanupFailure = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Authoritative refresh context release failed.', { cause: errors[0] });
        throw owner.cleanupFailure;
      }
    })();
    return loaded;
  }, loadOriginal);
  current.host.loadContext = loadContext;
  current.host.now = () => refreshedAt;
  current.host.updates.now = () => refreshedAt;
  current.host.logger = { error: reason => logs.push(reason) };
  current.host.linkedChildren = new Proxy(current.linkedChildren, { get(target, key) {
    if (key === 'flushReleases') return async (...args) => {
      const errors = [];
      try { await target.flushReleases(...args); } catch (error) { errors.push(error); }
      try { await finalResource?.release(action.finalSqlFailure); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Final refresh resource release failed.', { cause: errors[0] });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });

  const closeHost = current.host.close.bind(current.host);
  current.host.close = async () => {
    const errors = [];
    try { await closeHost(); report.cleanup.hostDrained = true; } catch (error) { errors.push(error); }
    for (const resource of resources) try {
      if (resource.release) await resource.release();
      else {
        if (resource.connection) { await resource.connection.end(); resource.connection.release(true); }
        await resource.file?.close();
      }
    } catch (error) { errors.push(error); }
    report.resources = resources.map(resource => ({ label: resource.label, filename: resource.filename, oid: resource.oid, pid: resource.pid,
      fd: resource.fd, fdReleased: resource.fdReleased, fdObservation: resource.fdObservation, closedObservation: resource.closedObservation,
      fileReleased: resource.fileReleased, connectionReleased: resource.connectionReleased, verifiedBeforeFixtureCleanup: resource.verified,
      cleanupFailure: errorObservation(resource.cleanupFailure) }));
    report.contexts = owners.map(owner => ({ id: owner.loaded.item.Id, disposed: owner.disposed, cleanupFailure: errorObservation(owner.cleanupFailure) }));
    report.diagnostics = logs.map(reason => ({ type: typeof reason, reason: errorObservation(reason) }));
    report.cleanup.errors = errors.map(error => errorObservation(error));
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n');
    if (errors.length) throw new AggregateError(errors, 'Refresh failure fixture cleanup failed.', { cause: errors[0] });
  };

  return { ...current, owners, resources, logs, report, loadOriginal,
    get action() { return action; }, get finalResource() { return finalResource; },
    async configure(value) {
      action = value;
      finalResource = value.finalSqlFailure ? await acquire('final linked release') : undefined;
    },
    async released(acquired) {
      for (const owner of acquired) {
        assert.equal(owner.disposed, true, 'The acquired authoritative context must actually dispose.');
        const resource = owner.resource;
        assert.equal(resource.fdObservation?.code, 'EBADF');
        const closed = await rejected(() => resource.file.stat());
        assert.equal(closed.code, 'closed'); resource.closedObservation = errorObservation(closed);
        const deadline = performance.now() + 5000;
        while ((await current.database.client.query('SELECT oid FROM pg_class WHERE oid=$1::oid', [resource.oid])).rows.length
          || (await current.database.client.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [resource.pid])).rows.length) {
          assert.ok(performance.now() < deadline, 'The acquired PostgreSQL relation and connection must actually disappear.');
          await delay(10);
        }
        resource.verified = true;
      }
    },
    async finalReleased() {
      await this.released([{ disposed: true, resource: finalResource }]);
    },
    async seed({ first = false, owned = false, version = false } = {}) {
      // End this fixture's previous owned relationship before its shared
      // reseeder removes the old owner row in primary-key order.
      await current.database.update('BaseItems', { Id: childId }, { OwnerId: null });
      return current.seed({ target: owned ? 'child' : 'owner', items: [
        { key: 'owner', Id: ownerId, type: 'Movie', Name: 'Original owner', Overview: 'Before probe.', Path: mediaPath,
          DateModified: current.now, DateLastRefreshed: first ? MIN_DATE : current.now },
        ...(version ? [{ key: 'version', Id: versionId, type: 'Movie', Name: 'Version' }] : []),
        ...(owned ? [{ key: 'child', Id: childId, type: 'Video', Name: 'Original child', OwnerId: version ? versionId : ownerId,
          Path: 'Z:\\ChildrenMetadata\\Refresh-part.mkv', DateModified: current.now,
          ...(version ? { ExtraType: 1 } : {}) }] : []),
      ] });
    },
  };
}

async function prefix(state, phase) {
  const key = state.action.key + '-' + phase, owner = state.owners.at(-1), bytes = Buffer.from('Committed ' + key);
  await testFileSystem.writeFile(owner.resource.filename, bytes);
  await state.database.setState(key + '-prefix', bytes.toString());
  try {
    await state.database.transaction(async transaction => {
      await transaction.setState(key + '-rollback', 'This value must roll back.');
      throw state.action.reason;
    });
  } catch (reason) { state.action.providerRejected = true; state.action.providerFailure = reason; throw reason; }
}

test('owned refresh preflight and failed loads release every PostgreSQL and Local context while retaining primitive primary reasons', {
  skip: !enabled, timeout: 120000,
}, async t => {
  const state = await fixture(t);
  for (const [kind, reason] of reasons) for (const loadFailure of [false, true]) await t.test(kind + (loadFailure ? '/load' : '/preflight'), async () => {
    await state.seed({ owned: true });
    const before = await state.database.rows('BaseItems'), start = state.owners.length;
    await state.configure({ rejectLoad: loadFailure ? childId : undefined, loadReason: reason,
      cleanupFor: loaded => sameId(loaded.item.Id, ownerId) ? { sqlFailure: 'missing-table' } : { reason } });
    const error = await rejected(() => state.host.refreshOwnedItem(ownerId, childId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }));
    const acquired = state.owners.slice(start), owner = acquired.find(value => sameId(value.loaded.item.Id, ownerId));
    assert.equal(owner.resource.cleanupFailure.code, '42P01');
    combined(error, [reason, owner.resource.cleanupFailure]);
    assert.deepEqual(await state.database.rows('BaseItems'), before);
    await state.released(acquired);
    state.report.cases.push({ kind, phase: loadFailure ? 'load' : 'preflight', reason: errorObservation(reason),
      failure: errorObservation(error), repositoryUnchanged: true, resourcesReleased: true });
  });
  await state.configure({});
  const recoveryStart = state.owners.length;
  const recovered = await state.host.refreshOwnedItem(ownerId, childId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.equal(recovered.changed, true);
  await state.released(state.owners.slice(recoveryStart));
});

test('owned version lookup and invalid live-parent validation retain their primary failure and release all acquired contexts', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const state = await fixture(t);
  await state.seed({ owned: true, version: true });
  const before = await state.database.rows('BaseItems');
  await state.configure({ lookupFailure: true, cleanupFor: loaded => sameId(loaded.item.Id, versionId) ? { reason: null }
    : sameId(loaded.item.Id, childId) ? { reason: false } : { sqlFailure: 'missing-table' } });
  const versionError = await rejected(() => state.host.refreshOwnedItem(ownerId, childId));
  const failures = leaves(versionError);
  assert.equal(failures[0].code, '22012');
  assert.deepEqual(failures.slice(1, 3), [null, false]);
  assert.equal(failures.at(-1).code, '42P01');
  assert.equal(versionError.code, '22012');
  assert.ok(state.owners.some(owner => sameId(owner.loaded.item.Id, versionId)));
  await state.released(state.owners);
  assert.deepEqual(await state.database.rows('BaseItems'), before);
  const start = state.owners.length;
  await state.configure({ cleanupFor: () => ({ reason: undefined }) });
  const invalid = await rejected(() => state.host.refreshSeasonWithLiveSeries(ownerId, { Id: versionId, Type: 'Series' }, { MetadataRefreshMode: 'None' }));
  assert.equal(invalid.code, 'metadata-conflict'); assert.equal(invalid.status, 409);
  assert.equal(invalid.cause.code, 'metadata-conflict'); assert.equal(invalid.cause.status, 409);
  combined(invalid, [invalid.cause, undefined]);
  await state.released(state.owners.slice(start));
  assert.deepEqual(await state.database.rows('BaseItems'), before);
  state.report.cases.push({ phase: 'version-lookup', failure: errorObservation(versionError), repositoryUnchanged: true, resourcesReleased: true },
    { phase: 'invalid-live-parent', failure: errorObservation(invalid), repositoryUnchanged: true, resourcesReleased: true });
  await state.seed({ owned: true, version: true });
  await state.database.update('BaseItems', { Id: childId }, { OwnerId: ownerId });
  const previewBefore = await state.database.rows('BaseItems'), previewStart = state.owners.length;
  state.registry.register({ id: 'preview-writer', name: 'Preview writer', providers: [{ id: 'writer', name: 'Preview writer', kind: 'saver',
    itemTypes: ['Video'], isEnabledFor: () => true, validateSave: async () => state.database.client.query('SELECT 1 / 0') }] });
  await state.configure({ previewParts: true, cleanupFor: loaded => sameId(loaded.item.Id, ownerId) ? { reason: undefined } : {} });
  const previewError = await rejected(() => state.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' }));
  assert.equal(previewError.code, '22012'); combined(previewError, [previewError.cause, undefined]);
  const previews = state.owners.slice(previewStart);
  assert.ok(previews.some(owner => sameId(owner.loaded.item.Id, versionId)), 'Later preview contexts are acquired before the first writer validation rejects.');
  await state.released(previews);
  assert.deepEqual(await state.database.rows('BaseItems'), previewBefore);
  state.report.cases.push({ phase: 'preview-writer-validation', failure: errorObservation(previewError), repositoryUnchanged: true, resourcesReleased: true });
});

test('primitive probe, local, remote and custom provider failures preserve best-effort successor commits and original diagnostics', {
  skip: !enabled, timeout: 120000,
}, async t => {
  const state = await fixture(t);
  state.host.probe = { supportsMetadata: () => true, async refreshMetadata() {
    if (state.action.phase === 'probe') await prefix(state, 'probe');
    return { changed: false, UpdateType: ItemUpdateType.None };
  } };
  state.registry.register({ id: 'refresh-failures', name: 'Refresh failures', providers: [
    ...['local', 'remote'].map(kind => ({ id: kind, name: kind, kind, itemTypes: ['Movie'], async getMetadata() {
      if (state.action.phase === kind) await prefix(state, kind);
      return { HasMetadata: false };
    } })),
    { id: 'custom', name: 'custom', kind: 'custom', itemTypes: ['Movie'], order: 0, async fetch() {
      if (state.action.phase === 'custom') await prefix(state, 'custom');
      return ItemUpdateType.None;
    } },
    { id: 'successor', name: 'successor', kind: 'custom', itemTypes: ['Movie'], order: 1, async fetch(item) {
      const key = state.action.key + '-' + state.action.phase;
      item.Name = 'Recovered ' + key;
      await state.database.setState(key + '-successor', item.Name);
      await testFileSystem.writeFile(state.owners.at(-1).resource.filename + '.saved', Buffer.from(item.Name));
      return ItemUpdateType.MetadataImport;
    } },
  ] });
  const business = Object.assign(new Error('A provider failed after its independently committed prefix.', { cause: null }), { code: 'provider-failure', status: 409, statusCode: 409, errors: [false, null] });
  for (const [kind, reason] of [...reasons, ['business', business]]) for (const phase of ['probe', 'local', 'remote', 'custom']) await t.test(kind + '/' + phase, async () => {
    await state.seed();
    const start = state.owners.length, key = kind + '-' + phase;
    await state.configure({ key, phase, reason });
    const result = await state.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(result.changed, true);
    assert.equal(result.Failures, phase === 'local' ? 0 : 1);
    assert.equal(state.action.providerRejected, true);
    assert.deepEqual(functionalError(state.action.providerFailure), functionalError(reason));
    assert.equal(result.ErrorMessage, reason?.message);
    const owner = state.owners.at(-1), expected = 'Recovered ' + key + '-' + phase;
    assert.equal((await state.database.rows('BaseItems', { where: { Id: ownerId } }))[0].Name, expected);
    assert.equal(await state.database.getState(key + '-' + phase + '-prefix'), 'Committed ' + key + '-' + phase);
    assert.equal(await state.database.getState(key + '-' + phase + '-rollback'), undefined);
    assert.equal(await state.database.getState(key + '-' + phase + '-successor'), expected);
    assert.deepEqual(await readFile(owner.resource.filename), Buffer.from('Committed ' + key + '-' + phase));
    assert.deepEqual(await readFile(owner.resource.filename + '.saved'), Buffer.from(expected));
    await state.released(state.owners.slice(start));
    state.report.cases.push({ kind, phase, reason: errorObservation(reason), providerFailure: errorObservation(state.action.providerFailure),
      providerFailureType: typeof state.action.providerFailure, providerFailureRaw: inspect(state.action.providerFailure, { depth: null }),
      result: { changed: result.changed, Failures: result.Failures, ErrorMessage: result.ErrorMessage },
      prefixRetained: true, failedTransactionRolledBack: true, successorCommitted: true, resourcesReleased: true });
  });
});

test('refresh cancellation retains the exact provider reason and first-save prefix while draining every later context and final release', {
  skip: !enabled, timeout: 120000,
}, async t => {
  const state = await fixture(t);
  let controller, prefixRows;
  const primary = Object.assign(new Error('The provider cancelled after the first save and probe commit.', { cause: null }),
    { code: 'refresh-cancelled', status: 409, statusCode: 409, errors: ['', false] });
  state.host.probe = { supportsMetadata: () => true, async refreshMetadata(loaded) {
    const persisted = await state.loadOriginal(loaded.item.Id);
    try { assert.equal(dateTicks(persisted.item.DateLastSaved), dateTicks(refreshedAt)); }
    finally { await persisted.dispose(); }
    await state.database.update('BaseItems', { Id: ownerId }, { Overview: 'Probe committed.' });
    return { changed: true, UpdateType: ItemUpdateType.MetadataImport };
  } };
  state.registry.register({ id: 'cancel', name: 'Cancel', providers: [
    { id: 'cancel', name: 'Cancel', kind: 'custom', itemTypes: ['Movie'], order: 0, async fetch(item) {
      if (state.action.recover) { item.Name = 'Recovered after cancellation.'; return ItemUpdateType.MetadataImport; }
      prefixRows = await state.database.rows('BaseItems');
      item.Name = 'This provider mutation must not commit.';
      if (!state.action.namedCancellation) controller.abort(state.action.reason);
      await prefix(state, 'cancel');
    } },
    { id: 'unreached', name: 'Unreached', kind: 'custom', itemTypes: ['Movie'], order: 1, async fetch() {
      if (state.action.recover) return ItemUpdateType.None;
      await state.database.setState(state.action.key + '-unreached', 'Must not commit after cancellation.');
      return ItemUpdateType.MetadataImport;
    } },
  ] });
  const named = new DOMException('Named provider cancellation without an aborted request signal.', 'AbortError');
  for (const [kind, reason] of [...reasons, ['named', named]]) await t.test('original-' + kind, async () => {
    await state.seed({ first: true }); controller = new AbortController();
    const start = state.owners.length;
    await state.configure({ key: 'cancel-' + kind, reason, namedCancellation: kind === 'named' });
    const error = await rejected(() => state.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal }));
    assert.deepEqual(functionalError(error), functionalError(reason));
    assert.deepEqual(await state.database.rows('BaseItems'), prefixRows);
    assert.equal((await state.database.rows('BaseItems', { where: { Id: ownerId } }))[0].Overview, 'Probe committed.');
    assert.equal(await state.database.getState('cancel-' + kind + '-cancel-prefix'), 'Committed cancel-' + kind + '-cancel');
    assert.deepEqual(await readFile(state.owners.at(-1).resource.filename), Buffer.from('Committed cancel-' + kind + '-cancel'));
    assert.equal(await state.database.getState('cancel-' + kind + '-cancel-rollback'), undefined);
    assert.equal(await state.database.getState('cancel-' + kind + '-unreached'), undefined);
    await state.released(state.owners.slice(start));
    state.report.cases.push({ kind, phase: 'cancel-original-reason', reason: errorObservation(reason), failure: errorObservation(error),
      firstSaveAndProbeCommitRetained: true, failedTransactionRolledBack: true, successorPrevented: true, resourcesReleased: true });
  });
  for (const [kind, cleanupReason] of reasons) await t.test('complete-cleanup-' + kind, async () => {
    await state.seed({ first: true }); controller = new AbortController();
    const start = state.owners.length;
    await state.configure({ key: 'cleanup-' + kind, reason: primary, finalSqlFailure: 'division',
      cleanupFor: loaded => loaded.snapshot.Overview === 'Probe committed.' ? { sqlFailure: 'missing-table' } : { reason: cleanupReason } });
    const error = await rejected(() => state.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal }));
    const acquired = state.owners.slice(start), reloaded = acquired.find(owner => owner.loaded.snapshot.Overview === 'Probe committed.');
    assert.ok(reloaded, 'A real probe commit must acquire its replacement authoritative context.');
    assert.equal(reloaded.resource.cleanupFailure.code, '42P01');
    assert.equal(state.finalResource.cleanupFailure.code, '22012');
    combined(error, [primary, cleanupReason, reloaded.resource.cleanupFailure, state.finalResource.cleanupFailure]);
    assert.deepEqual(await state.database.rows('BaseItems'), prefixRows);
    assert.equal(await state.database.getState('cleanup-' + kind + '-cancel-prefix'), 'Committed cleanup-' + kind + '-cancel');
    assert.deepEqual(await readFile(reloaded.resource.filename), Buffer.from('Committed cleanup-' + kind + '-cancel'));
    await state.released(acquired); await state.finalReleased();
    assert.equal(await state.database.getState('cleanup-' + kind + '-cancel-rollback'), undefined);
    assert.equal(await state.database.getState('cleanup-' + kind + '-unreached'), undefined);
    state.report.cases.push({ kind, phase: 'cancel-with-cleanup-failures', failure: errorObservation(error),
      firstSaveAndProbeCommitRetained: true, failedTransactionRolledBack: true, successorPrevented: true, resourcesReleased: true, finalFlushReleased: true });
  });
  controller = new AbortController();
  await state.configure({ key: 'recovery', recover: true });
  await state.seed({ first: true });
  const recoveryStart = state.owners.length;
  const recovered = await state.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(recovered.changed, true);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: ownerId } }))[0].Name, 'Recovered after cancellation.');
  await state.released(state.owners.slice(recoveryStart));
});
