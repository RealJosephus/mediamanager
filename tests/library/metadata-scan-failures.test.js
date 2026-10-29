import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { attachNativeItemResourceGraph } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { libraryFailureFixture, reasonCases, outcome, observation, sameReason, combined } from './library-failure-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 360000 };
const receiptFailure = (receipt, item, reason) => {
  assert.equal(receipt.errors.length, 1);
  const entry = receipt.errors[0]; assert.equal(Object.hasOwn(entry, 'reason'), true);
  assert.deepEqual({ itemId: entry.itemId, type: entry.type, name: entry.name, code: entry.code, message: entry.message },
    { itemId: item.Id, type: item.Type, name: item.Name, code: reason?.code, message: reason?.message });
  sameReason(entry.reason, reason);
};
const missingAsset = async (f, key) => {
  const result = await outcome(f.fileSystem.readFile(path.join(f.files, key + '.png')));
  assert.equal(result.failed, true); assert.equal(result.reason?.code, 'ENOENT'); assert.equal(result.reason?.storageCode, 'not-found');
};

for (const setting of [1, 2]) test(`postgres: metadata mode ${setting} returns original child reasons, continues real commits and recovers`, options, async t => {
  const f = await libraryFailureFixture(t, 'metadata-receipts-' + setting);
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: setting } }); f.schedulers.push(scheduler);
  for (const entry of ['children', 'accessible']) for (const [name, reason] of reasonCases()) {
    const label = entry + ':' + name; await f.reset(); let fail = true, sourceEntered = false, stage = label;
    const metadata = { validateRefresh() {}, loadContext: { linkedChildren: f.links }, async refreshLiveItem(item) {
      await f.persist(item, stage);
      if (fail && idKey(item.Id) === idKey(f.ids.first)) { sourceEntered = true; throw reason; }
      return { UpdateType: 1, changed: true, Failures: 0 };
    } };
    const scanner = new LibraryMetadataScanService({ library: f.library, metadata, scheduler, stateLoader: f.stateLoader(label),
      logger: { error: value => { f.report.diagnostics.push(observation(value)); throw 0; } } });
    const invoke = async () => entry === 'children' ? scanner.refreshChildren(f.ids.root, {}, { recursive: false })
      : scanner.refreshAccessibleChildren((await f.sequence(['first', 'next'], stage)).owned, {}, { recursive: false });
    const result = await invoke(); assert.equal(sourceEntered, true);
    receiptFailure(result, await f.item('first'), reason);
    assert.equal(result.attemptedCount, 2); assert.equal(result.updatedCount, 1); assert.equal(result.providerFailures, 0); assert.equal(result.cancelled, false);
    for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, label);
    const released = await f.released(); fail = false; stage += ':recovery';
    const recovered = await invoke(); assert.equal(recovered.attemptedCount, 2); assert.equal(recovered.updatedCount, 2);
    assert.deepEqual(recovered.errors, []);
    for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, stage);
    f.report.cases.push({ phase: 'receipt', entry, name, sourceEntered, receipt: { ...result, errors: result.errors.map(error => ({ ...error, reason: observation(error.reason) })) },
      released, recovered, recoveryReleased: await f.released() });
  }
});

test('postgres: metadata source, sequence and state cleanup preserve ordered reasons and release recursive count owners', options, async t => {
  const f = await libraryFailureFixture(t, 'metadata-resource-failures');
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } }); f.schedulers.push(scheduler);
  let stage = '', handlerFailure, handlerFailed = false;
  const metadata = { validateRefresh() {}, loadContext: { linkedChildren: f.links }, async refreshLiveItem(item) {
    await f.persist(item, stage); if (handlerFailed) throw handlerFailure;
    return { UpdateType: 1, changed: true, Failures: 0 };
  } };
  const scanner = control => new LibraryMetadataScanService({ library: f.library, metadata, scheduler,
    stateLoader: f.stateLoader(stage, control), logger: { error: value => f.report.diagnostics.push(observation(value)) } });
  for (const [name, reason] of reasonCases()) for (const entry of ['accessible', 'children', 'state']) {
    stage = entry + '-cleanup:' + name; await f.reset(); handlerFailed = entry === 'state'; handlerFailure = reason;
    const control = { nextReason: reason, closeReason: 0 };
    let result;
    if (entry === 'accessible') result = await outcome(scanner().refreshAccessibleChildren((await f.sequence(['first', 'next'], stage, control)).owned,
      {}, { recursive: false }));
    else if (entry === 'children') result = await outcome(scanner({ physical: control, stateCloseReason: undefined }).refreshChildren(f.ids.root,
      {}, { recursive: false }));
    else result = await outcome(scanner({ stateCloseReason: 0 }).refreshContainer(f.ids.series));
    assert.equal(result.failed, true);
    if (entry === 'children') { combined(result.reason.errors[0], reason, [0]); combined(result.reason, result.reason.errors[0], [undefined]); }
    else combined(result.reason, reason, [0]);
    if (entry === 'state') assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids.series } }))[0].Overview, stage);
    else for (const key of ['first', 'next']) {
      assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, ''); await missingAsset(f, key);
    }
    const released = await f.released(); handlerFailed = false;
    const recovery = await scanner().refreshChildren(f.ids.root, {}, { recursive: false }); assert.deepEqual(recovery.errors, []);
    assert.equal(recovery.attemptedCount, 2);
    f.report.cases.push({ phase: 'cleanup', entry, name, primary: observation(reason), reason: observation(result.reason), released,
      recovery, recoveryReleased: await f.released() });
  }
  for (const [name, reason] of reasonCases()) for (const entry of ['sequence-close', 'state-close']) {
    stage = entry + ':' + name; await f.reset(); handlerFailed = false;
    const result = await outcome(entry === 'sequence-close'
      ? scanner().refreshAccessibleChildren((await f.sequence(['first', 'next'], stage, { closeReason: reason })).owned, {}, { recursive: false })
      : scanner({ stateCloseReason: reason }).refreshChildren(f.ids.root, {}, { recursive: false }));
    assert.equal(result.failed, true); sameReason(result.reason, reason);
    for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, stage);
    const released = await f.released(); stage += ':recovery';
    const recovery = await scanner().refreshChildren(f.ids.root, {}, { recursive: false }); assert.deepEqual(recovery.errors, []);
    f.report.cases.push({ phase: entry, name, reason: observation(result.reason), released, recovery, recoveryReleased: await f.released() });
  }
  for (const kind of ['series', 'album']) for (const [name, reason] of reasonCases()) for (const cleanup of [false, true]) {
    stage = kind + '-count:' + name + ':' + cleanup; await f.reset(); handlerFailed = false;
    const sequenceStart = f.report.sequences.length;
    const result = await outcome(scanner({ recursive: { countReason: reason, ...(cleanup ? { closeReason: 0 } : {}) } }).refreshContainer(f.ids[kind]));
    assert.equal(result.failed, true); if (cleanup) combined(result.reason, reason, [0]); else sameReason(result.reason, reason);
    const owned = f.report.sequences.slice(sequenceStart); assert.ok(owned.some(entry => entry.countCompleted));
    for (const entry of owned) { assert.equal(entry.nextCompleted, false); assert.equal(entry.closed, true); }
    assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[kind] } }))[0].Overview, kind === 'series' ? stage : '');
    for (const key of kind === 'series' ? ['season', 'episode'] : ['audio']) {
      assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, ''); await missingAsset(f, key);
    }
    const released = await f.released(), recovered = await scanner().refreshContainer(f.ids[kind]);
    assert.deepEqual(recovered.errors, []); assert.equal(recovered.attemptedCount, kind === 'series' ? 4 : 2);
    f.report.cases.push({ phase: 'recursive-count', kind, name, cleanup, reason: observation(result.reason), released,
      recovered, recoveryReleased: await f.released() });
  }
});

test('postgres: manual album artist work preserves primary, actual release and flush failures in order', options, async t => {
  const f = await libraryFailureFixture(t, 'metadata-artist-failures');
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } }); f.schedulers.push(scheduler);
  for (const [name, reason] of reasonCases()) {
    const stage = 'artist:' + name; await f.reset();
    let sourceEntered = false, releaseEntered = false, flushEntered = false;
    const retain = f.creator.retainItem, flush = f.links.flushReleases;
    f.creator.retainItem = function (item) {
      const artist = idKey(item.Id) === idKey(f.ids.artist);
      if (artist) attachNativeItemResourceGraph(item, f.links.resourceGraph);
      const owner = retain.call(this, item);
      if (!artist) return owner;
      return { async release() { await owner.release(); await f.links.resourceGraph.flush(); releaseEntered = true; throw 0; } };
    };
    f.links.flushReleases = async function (...args) {
      const value = await flush.apply(this, args);
      if (releaseEntered && !flushEntered) { flushEntered = true; throw undefined; } return value;
    };
    const metadata = { validateRefresh() {}, loadContext: { linkedChildren: f.links }, async refreshLiveItem(item) {
      await f.persist(item, stage);
      if (idKey(item.Id) === idKey(f.ids.artist)) { await f.links.resourceGraph.flush(); sourceEntered = true; throw reason; }
      return { UpdateType: 1, changed: true, Failures: 0 };
    } };
    const scanner = new LibraryMetadataScanService({ library: f.library, metadata, scheduler, stateLoader: f.stateLoader(stage) });
    let result;
    try {
      result = await outcome(scanner.refreshContainer(f.ids.album, { IsAutomated: false })); assert.equal(result.failed, true);
      assert.equal(sourceEntered, true); assert.equal(releaseEntered, true); assert.equal(flushEntered, true);
      combined(result.reason, reason, [0, undefined]);
    } finally { f.creator.retainItem = retain; f.links.flushReleases = flush; }
    for (const key of ['audio', 'album', 'artist']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, stage);
    const released = await f.released(), recovered = new LibraryMetadataScanService({ library: f.library, scheduler,
      stateLoader: f.stateLoader(stage + ':recovery'), metadata: { ...metadata, async refreshLiveItem(item) {
        await f.persist(item, stage + ':recovery'); return { UpdateType: 1, changed: true, Failures: 0 };
      } } });
    const recovery = await recovered.refreshContainer(f.ids.album, { IsAutomated: false }); assert.deepEqual(recovery.errors, []);
    assert.equal(recovery.attemptedCount, 3);
    f.report.cases.push({ phase: 'artist-release', name, sourceEntered, releaseEntered, flushEntered, reason: observation(result.reason), released,
      recovery, recoveryReleased: await f.released() });
  }
});

test('postgres: actual caller cancellation keeps its reason and committed prefix while later metadata work recovers', options, async t => {
  const f = await libraryFailureFixture(t, 'metadata-cancellation-failures');
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } }); f.schedulers.push(scheduler);
  for (const [name, requestedReason] of reasonCases()) for (const phase of ['before', 'during']) {
    const stage = phase + ':' + name; await f.reset(); const controller = new AbortController(); let cancel = phase === 'during';
    if (phase === 'before') controller.abort(requestedReason);
    const metadata = { validateRefresh() {}, loadContext: { linkedChildren: f.links }, async refreshLiveItem(item, requestOptions) {
      await f.persist(item, stage);
      if (cancel && idKey(item.Id) === idKey(f.ids.first)) { controller.abort(requestedReason); requestOptions.signal.throwIfAborted(); }
      return { UpdateType: 1, changed: true, Failures: 0 };
    } };
    const scanner = new LibraryMetadataScanService({ library: f.library, metadata, scheduler, stateLoader: f.stateLoader(stage),
      logger: { error: value => f.report.diagnostics.push(observation(value)) } });
    const current = await f.sequence(['first', 'next'], stage), result = await scanner.refreshAccessibleChildren(current.owned,
      { signal: controller.signal }, { recursive: false });
    assert.equal(controller.signal.aborted, true); assert.equal(result.cancelled, true);
    assert.equal(result.attemptedCount, phase === 'before' ? 0 : 1);
    if (phase === 'before') { assert.deepEqual(result.errors, []); await missingAsset(f, 'first'); }
    else receiptFailure(result, await f.item('first'), controller.signal.reason);
    for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview,
      phase === 'during' && key === 'first' ? stage : '');
    await missingAsset(f, 'next'); const released = await f.released(); cancel = false;
    const recovery = await scanner.refreshChildren(f.ids.root, {}, { recursive: false }); assert.equal(recovery.cancelled, false);
    assert.deepEqual(recovery.errors, []); assert.equal(recovery.updatedCount, 2);
    f.report.cases.push({ phase: 'cancellation-' + phase, name, requestedReason: observation(requestedReason), actualSignalReason: observation(controller.signal.reason),
      receipt: { ...result, errors: result.errors.map(error => ({ ...error, reason: observation(error.reason) })) }, released,
      recovery, recoveryReleased: await f.released() });
  }
});
