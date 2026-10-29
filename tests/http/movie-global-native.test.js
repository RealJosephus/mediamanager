import test, { after } from 'node:test';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureMovieGlobal, json } from './fixtures/movie-global-native/capture.js';
import { runMovieCandidate } from './fixtures/movie-global-native/candidate.js';
import { assertAggregatePhysicalLocationSet, differences, normalizeAggregatePhysicalLocations,
  projectMovieRun, stabilizeConcurrentBoxSetEventOrder,
  stabilizeMovieEventProjection, movieConcurrentEventPolicy, assertMovieEventCausality,
  projectMovieData, projectMovieXml } from './fixtures/movie-global-native/projection.js';
import { readXml } from '../../src/core/xml.js';
import { dateTicks } from '../../src/library/records.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const resourceLease = enabled ? await acquireTestResource('native-media-5244') : null;

test('Movie projection preserves AggregateFolder Path and normalizes only additional-location enumeration', () => {
  const aggregate = 'MediaBrowser.Controller.Entities.AggregateFolder|$CASE/program/root';
  const native = ['$CASE/program/root', '$CASE/media', '$CASE/program/data/collections'];
  const node = ['$CASE/program/root', '$CASE/program/data/collections', '$CASE/media'];
  assert.deepEqual(normalizeAggregatePhysicalLocations(native, aggregate),
    normalizeAggregatePhysicalLocations(node, aggregate));
  assert.equal(normalizeAggregatePhysicalLocations(node, aggregate)[0], '$CASE/program/root');
  assert.throws(() => normalizeAggregatePhysicalLocations(['$CASE/media', '$CASE/program/root'], aggregate),
    /own Path at index 0/u);
  assert.doesNotThrow(() => assertAggregatePhysicalLocationSet(native, '$CASE/program/root', native));
  assert.throws(() => assertAggregatePhysicalLocationSet(
    ['$CASE/program/root', '$CASE/media', '$CASE/media'], '$CASE/program/root', native), /must not contain duplicates/u);
  assert.throws(() => assertAggregatePhysicalLocationSet(
    ['$CASE/program/root', '$CASE/media'], '$CASE/program/root', native), /complete raw location set/u);

  const collection = 'MediaBrowser.Controller.Entities.CollectionFolder|$CASE/program/root/default/Movies';
  assert.deepEqual(normalizeAggregatePhysicalLocations(native, collection), native);
  assert.notDeepEqual(normalizeAggregatePhysicalLocations(native, collection),
    normalizeAggregatePhysicalLocations(node, collection), 'CollectionFolder location order remains significant.');
});

test('Movie projection stabilizes only mutable fields on the live BoxSet MetadataEdit event sample', () => {
  const stable = { phase: 'created', action: 'updated', id: 'boxset',
    type: 'MediaBrowser.Controller.Entities.Movies.BoxSet', path: '$CASE/program/data/collections/fixture',
    parent: null, updateReason: 16, ParentId: 'collections', OwnerId: '$EMPTY', IsFolder: true };
  const beforeRefresh = { ...stable, Name: 'Scan Fixture Collection', Genres: [], Studios: [],
    tmdbCollectionName: null, Overview: null, RunTimeTicks: null, ProviderIds: {}, IsLocked: false,
    DateCreated: '2026-10-27T00:00:00Z', DateModified: '2026-10-27T00:00:00Z', DateLastSaved: '2026-10-27T00:00:00Z', DateLastRefreshed: '2026-10-27T00:00:00Z' };
  const duringRefresh = { ...beforeRefresh, Genres: ['Scan Original Genre'],
    Studios: ['Scan Fixture Studio', ''], DateModified: '0001-01-01T00:00:00Z' };
  const options = { policy: { Genres: [beforeRefresh.Genres, duringRefresh.Genres].map(value => ({ value })),
    Studios: [beforeRefresh.Studios, duringRefresh.Studios].map(value => ({ value })) }, validateDate: value => {
    const ticks = dateTicks(value); assert.ok(ticks === 0n || ticks >= dateTicks('2026-10-27T00:00:00Z') && ticks <= dateTicks('2026-10-27T00:01:00Z'));
  } };
  const project = value => stabilizeMovieEventProjection(value, options);
  assert.deepEqual(project(beforeRefresh), project(duringRefresh));
  assert.notDeepEqual(project({ ...beforeRefresh, id: 'different' }), project(beforeRefresh), 'BoxSet MetadataEdit identity remains strict.');
  assert.notDeepEqual(project({ ...beforeRefresh, Name: 'different' }), project(beforeRefresh), 'BoxSet MetadataEdit content remains strict.');
  assert.notDeepEqual(project({ ...beforeRefresh, ProviderIds: { Tmdb: '42' } }), project(beforeRefresh), 'Provider identities remain strict.');
  assert.throws(() => project({ ...beforeRefresh, Genres: ['never observed'] }), { code: 'MOVIE_OBSERVATION_REVIEW_REQUIRED' });
  for (const field of ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed']) {
    const missing = { ...beforeRefresh }; delete missing[field]; assert.throws(() => project(missing));
    assert.throws(() => project({ ...beforeRefresh, [field]: null }));
    assert.throws(() => project({ ...beforeRefresh, [field]: '1900-01-01T00:00:00Z' }));
  }

  const metadataImportBefore = { ...beforeRefresh, updateReason: 2 };
  const metadataImportAfter = { ...duringRefresh, updateReason: 2 };
  assert.equal(stabilizeMovieEventProjection(metadataImportBefore), metadataImportBefore);
  assert.notDeepEqual(stabilizeMovieEventProjection(metadataImportBefore),
    stabilizeMovieEventProjection(metadataImportAfter), 'Other BoxSet update reasons retain full metadata strictness.');
  const movieEdit = { ...beforeRefresh, type: 'MediaBrowser.Controller.Entities.Movies.Movie' };
  assert.equal(stabilizeMovieEventProjection(movieEdit), movieEdit);
  for (const later of [{ ...beforeRefresh, phase: 'updated' }, { ...beforeRefresh, phase: 'deleted' },
    { ...beforeRefresh, action: 'added' }]) {
    assert.equal(stabilizeMovieEventProjection(later), later);
    assert.notDeepEqual(stabilizeMovieEventProjection(later),
      stabilizeMovieEventProjection({ ...later, Genres: ['different'] }),
      'Only the observed created-phase updated callback may stabilize its raced fields.');
  }
});

test('Movie projection canonicalizes only the exact concurrent BoxSet refresh callback cohort', () => {
  const event = (updateReason, extra = {}) => ({ phase: 'created', action: 'updated',
    type: 'MediaBrowser.Controller.Entities.Movies.BoxSet', updateReason, marker: String(updateReason), ...extra });
  const added = event(0, { action: 'added' }), image = event(9);
  const expected = [added, event(16), event(2), event(19), image];
  for (const reasons of [[16, 2, 19], [2, 16, 19], [2, 19, 16]]) {
    assert.deepEqual(stabilizeConcurrentBoxSetEventOrder([added, ...reasons.map(reason => event(reason)), image], { before: [[2, 19]] }), expected);
  }
  for (const reasons of [[16, 19, 2], [19, 16, 2], [19, 2, 16]]) assert.throws(() =>
    stabilizeConcurrentBoxSetEventOrder([added, ...reasons.map(reason => event(reason)), image], { before: [[2, 19]] }), /causal edge/u);
  const unrelated = [added, image];
  assert.equal(stabilizeConcurrentBoxSetEventOrder(unrelated), unrelated,
    'Unrelated events are returned without cohort normalization.');
  assert.throws(() => stabilizeConcurrentBoxSetEventOrder([event(16), event(2)]), /exactly the observed callback cohort/u);
  assert.throws(() => stabilizeConcurrentBoxSetEventOrder([event(16), event(2), event(2)]), /each reason exactly once/u);
  assert.throws(() => stabilizeConcurrentBoxSetEventOrder([event(16), event(9), event(2), event(19)]), /must not cross/u);
  for (const changed of [{ phase: 'updated' }, { action: 'added' },
    { type: 'MediaBrowser.Controller.Entities.Movies.Movie' }]) {
    const events = [event(16, changed), event(2, changed), event(19, changed)];
    assert.equal(stabilizeConcurrentBoxSetEventOrder(events), events,
      'Other phases, actions and item types retain their observed order.');
  }
});

test('Movie typed Data keeps unknown GUID, path, date and ordered extension values literal', () => {
  const type = 'MediaBrowser.Controller.Entities.AggregateFolder', logical = type + '|$CASE/program/root';
  const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', stamp = '2026-10-27T00:00:00Z';
  const original = { PhysicalLocationsList: ['/case/program/root', '/case/b', '/case/a'], DateLastSaved: stamp,
    ProviderIds: { External: guid }, Description: '/case/business', Unknown: { Id: guid, DateLastSaved: 'opaque-date',
      PhysicalLocationsList: ['/case/program/root', 'z', 'a'] }, UnknownNumber: 1 };
  const text = JSON.stringify(original).replace('"UnknownNumber":1', '"UnknownNumber":1e0');
  const project = text => projectMovieData(text, type, { logical, phase: 'created',
    identity: value => '$identity:' + value, rooted: value => typeof value === 'string' ? value.replace('/case/', '$CASE/') : value,
    clock: () => '$actual-clock' });
  const result = project(text);
  assert.deepEqual(result.value.ProviderIds, original.ProviderIds); assert.deepEqual(result.value.Unknown, original.Unknown);
  assert.equal(result.value.Description, original.Description);
  assert.deepEqual(result.value.PhysicalLocationsList, ['$CASE/program/root', '$CASE/a', '$CASE/b']);
  assert.notDeepEqual(project(text.replace('1e0', '1.0')), result, 'Unknown persistent number tokens cannot disappear through JSON parsing.');
  const known = '{"PhysicalLocationsList":["/case/program/root","/case/b","/case/a"],"DateLastSaved":"' + stamp + '"}';
  assert.deepEqual(project(known), project('{ "DateLastSaved": "' + stamp + '", "PhysicalLocationsList": ["/case/program/root","/case/a","/case/b"] }'));
});

test('Movie XML projections respect actual namespace and ancestry and preserve unknown mixed content', () => {
  const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const project = xml => projectMovieXml(readXml(xml), { type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    rooted: value => value.replace('/case/', '$CASE/'), dateadded: () => '$actual-date', added: () => { throw new Error('Not a BoxSet document.'); }, framerate: value => Math.fround(Number(value)) });
  const value = project('<movie><dateadded>2026-10-27 00:00:00</dateadded><path>/case/media/a.mkv</path><custom><Added>opaque</Added><Path>/case/opaque</Path><Id>' + guid + '</Id> <part/> </custom></movie>');
  assert.equal(value.content[0].text, '$actual-date'); assert.equal(value.content[1].text, '$CASE/media/a.mkv');
  const custom = value.content[2]; assert.equal(custom.content[0].text, 'opaque'); assert.equal(custom.content[1].text, '/case/opaque');
  assert.equal(custom.content[2].text, guid); assert.equal(custom.content[3], ' '); assert.equal(custom.content[5], ' ');
  assert.equal(project('<movie xmlns="urn:vendor"><dateadded>opaque</dateadded></movie>').content[0].text, 'opaque');
  assert.equal(project('<movie xmlns="urn:vendor"><dateadded xmlns="">opaque</dateadded></movie>').content[0].text, 'opaque');
  assert.notDeepEqual(project('<movie xmlns:p="urn:first" p:meaning="value"/>'),
    project('<movie xmlns:p="urn:second" p:meaning="value"/>'));
  assert.deepEqual(project('<movie xmlns:p="urn:unused"/>'), project('<movie/>'));
  assert.notDeepEqual(project('<movie><custom> <part/> </custom></movie>'), project('<movie><custom><part/></custom></movie>'));
  assert.deepEqual(project('<movie>\n<path>/case/a</path>\n</movie>'), project('<movie><path>/case/a</path></movie>'));
});

test('Movie callback causality follows actual metadata and queue spans without fixing cross-thread timing', () => {
  const item = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'MediaBrowser.Controller.Entities.Movies.BoxSet' };
  const event = (reason, metadataId = 7) => ({ action: 'updated', metadataId, requestId: metadataId == null ? null : 1,
    detail: { item, updateReason: reason } });
  const source = [
    { action: 'queue-metadata-start', detail: { requestId: 1, itemId: item.id } },
    { action: 'metadata-begin', metadataId: 7, detail: { item } }, event(2), event(16, null),
    { action: 'queue-admission-begin', detail: { requestId: 2, itemId: item.id, options: { ForceSave: true } } },
    event(19), { action: 'metadata-completed', metadataId: 7, detail: { item } },
    { action: 'queue-metadata-completed', detail: { requestId: 1 } },
  ];
  const trace = values => values.map((entry, index) => ({ phase: 'created', ...entry, ordinal: index + 1 }));
  assert.deepEqual(assertMovieEventCausality(trace(source)).get(item.id.replaceAll('-', '')), [[2, 19]]);
  const swapped = [...source]; [swapped[2], swapped[5]] = [swapped[5], swapped[2]];
  assert.throws(() => assertMovieEventCausality(trace(swapped)), /first save before its final save/u);
  const missingOwner = [...source]; missingOwner[2] = event(2, null);
  assert.throws(() => assertMovieEventCausality(trace(missingOwner)), /actual owning metadata operation/u);
  const admissionFirst = [...source]; [admissionFirst[3], admissionFirst[4]] = [admissionFirst[4], admissionFirst[3]];
  assert.throws(() => assertMovieEventCausality(trace(admissionFirst)), /MetadataEdit must complete/u);
  const child = { id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'MediaBrowser.Controller.Entities.Movies.Movie' };
  assert.doesNotThrow(() => assertMovieEventCausality(trace([...source,
    { action: 'metadata-begin', metadataId: 8, requestId: 1, detail: { item: child } },
    { action: 'updated', metadataId: 8, requestId: 1, detail: { item: child, updateReason: 2 } },
    { action: 'metadata-completed', metadataId: 8, requestId: 1, detail: { item: child } },
  ])), 'Real queued Folder validation may refresh a child after the target metadata span.');
});

test('two independent actual Movie global scans match PG create, timed NFO update, delete, full 33 tables, XML, Item events and metadata queue drain', {
  skip: !enabled, timeout: 900000,
}, async t => {
  let capture, candidate, failure;
  const report = { schemaVersion: 1, comparisons: [], projections: {},
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'One controlled offline two-Movie/one-BoxSet lifecycle, three complete global scans per run. Actual native LibraryManager, Movie/BoxSet services, NFO/XML, ffprobe, CollectionManager and eight real post-scan tasks, repeated independently; production PG imports the identical frozen full-schema preparation input.',
    unmetPrerequisites: ['This bounded scenario does not establish complete-library coverage, production scale, HTTP authorization, real stopped-instance migration or final release acceptance.'] };
  try {
    capture = await captureMovieGlobal({ signal: t.signal });
    t.signal.throwIfAborted();
    candidate = await runMovieCandidate(capture);
    const specification = JSON.parse(await readFile(new URL('./fixtures/movie-global-native/input.json', import.meta.url), 'utf8'));
    const runs = [['native-first', capture.first], ['native-repeat', capture.repeat], ['postgres', candidate]];
    const eventPolicy = movieConcurrentEventPolicy([capture.first, capture.repeat]);
    report.concurrentNativeObservations = eventPolicy;
    for (const [name, record] of runs) {
      assert.equal(record.observations.length, 6, name);
      assert.deepEqual(record.observations.map(value => [value.phase, value.boundary]), specification.phases
        .flatMap(phase => [[phase, 'global-returned'], [phase, 'metadata-drained']]));
      if (name.startsWith('native')) {
        assert.equal(record.fullSchemaCloned, true); assert.equal(record.schemaCreated, false);
        assert.equal(record.preparationExecutedAsBusiness, false); assert.equal(record.protectedInputsUnchanged, true);
        assert.equal(record.failure, null);
        // Native best-effort diagnostics remain in the raw trace. Drained
        // persisted state, files, events and queue outcomes decide parity.
        assert.deepEqual(record.releasedResources, ['scheduler', 'provider', 'media-encoder', 'image-processor',
          'media-source-manager', 'recordings-manager', 'plugins', 'services', 'cache-and-tokens']);
        assert.equal(record.registration.mediaSourceManager, 'Emby.Server.Implementations.Library.MediaSourceManager');
        assert.equal(record.registration.recordingsManager, 'Jellyfin.LiveTv.Recordings.RecordingsManager');
        assert.equal(record.registration.recordingInitialState.timers, 0);
        assert.equal(record.registration.recordingInitialState.seriesTimers, 0);
        assert.deepEqual(record.registration.recordingInitialState.recordingFolders, []);
        const recordingReads = record.trace.filter(value => value.action === 'recording-active-query-begin');
        const recordingResults = record.trace.filter(value => value.action === 'recording-active-query-completed');
        assert.ok(recordingReads.length > 0, 'Movie persistence must consult the actual recording service.');
        assert.equal(recordingResults.length, recordingReads.length);
        assert.equal(recordingResults.every(value => value.detail.hasActiveRecording === false), true);
        assert.deepEqual(record.trace.filter(value => value.action === 'recording-active-query-failed'), []);
      }
      for (const observation of record.observations.filter(value => value.boundary === 'metadata-drained')) {
        assert.equal(observation.snapshot.files.some(file => Object.hasOwn(file, 'readError')), false,
          'Stable snapshots follow actual worker completion and must read every sidecar successfully.');
      }
      try { report.projections[name] = projectMovieRun(record, specification, eventPolicy); }
      catch (error) { report.projections[name] = { failure: { name: error.name, message: error.message, stack: error.stack,
        ...(error.code === 'MOVIE_OBSERVATION_REVIEW_REQUIRED' ? { reviewRequired: true, observation: error.observation } : {}) } }; }
    }
    const expected = report.projections['native-first'];
    for (const name of ['native-repeat', 'postgres']) {
      const actual = report.projections[name];
      const difference = differences({ stages: actual.stages, events: actual.events, scanOutcomes: actual.scanOutcomes, queued: actual.queued, failure: actual.failure },
        { stages: expected.stages, events: expected.events, scanOutcomes: expected.scanOutcomes, queued: expected.queued, failure: expected.failure });
      report.comparisons.push({ name, ...difference, passed: !actual.failure && !expected.failure && difference.entries.length === 0 });
    }
    report.inputSha256 = capture.report.boundInput.sha256;
    report.fullTablesPerBoundary = 33; report.rawBoundaries = runs.length * 6;
    report.postScanTaskOrders = Object.fromEntries(runs.map(([name, record]) => [name, record.registration.postScanTasks]));
    const order = name => report.projections[name].registrationOrder;
    assert.deepEqual(order('native-repeat'), order('native-first'), 'Independent designated exports must retain their actual native order.');
    report.postScanTaskOrderComparison = { native: order('native-first'), postgres: order('postgres'),
      same: JSON.stringify(order('native-first')) === JSON.stringify(order('postgres')),
      isolatedOrderIsAcceptanceGate: false,
      acceptance: 'Each side must invoke its own actual registered/exported order. A cross-runtime order difference is judged by full persisted state, XML, Item events, queue request/metadata completion/drain outcomes; order alone is not a functional rejection.' };
    report.nativeProcessInstances = [capture.first.process, capture.repeat.process];
    report.nativeProcessesIndependent = capture.first.process.entryAssembly !== capture.repeat.process.entryAssembly
      && (capture.first.process.pid !== capture.repeat.process.pid || capture.first.process.startedAt !== capture.repeat.process.startedAt);
    assert.equal(report.nativeProcessesIndependent, true);
    assert.deepEqual(report.comparisons.map(value => ({ name: value.name, passed: value.passed, differences: value.entries.length })),
      [{ name: 'native-repeat', passed: true, differences: 0 }, { name: 'postgres', passed: true, differences: 0 }],
      'See comparison.json for every retained identity/clock binding and exact difference; raw inputs and all-table observations remain unchanged.');
    report.boundedScenarioPassed = true;
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    try { await capture?.finish(); }
    catch (error) { failure ??= error; report.inputCleanupFailure = { name: error.name, message: error.message, stack: error.stack }; }
    if (capture) {
      report.protectedInputsUnchanged = capture.report.protectedInputsUnchanged;
      report.candidateCleanup = candidate?.cleanup ?? null;
      const text = json(report);
      await writeFile(path.join(capture.root, 'comparison.json'), process.env.MEDIAMANAGER_TEST_POSTGRES
        ? text.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]') : text);
    }
  }
  if (failure) throw failure;
});

// Release after all test hooks, streams, processes and resource postconditions.
after(async () => { await resourceLease?.release(); });
