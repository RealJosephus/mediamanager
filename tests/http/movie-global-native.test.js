import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureMovieGlobal, json } from './fixtures/movie-global-native/capture.js';
import { runMovieCandidate } from './fixtures/movie-global-native/candidate.js';
import { projectMovieRun, differences } from './fixtures/movie-global-native/projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('two independent actual Movie global scans match PG create, timed NFO update, delete, full 33 tables, XML, Item events and metadata queue drain', {
  skip: !enabled, timeout: 900000,
}, async () => {
  let capture, candidate, failure;
  const report = { schemaVersion: 1, comparisons: [], projections: {},
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'One controlled offline two-Movie/one-BoxSet lifecycle, three complete global scans per run. Actual native LibraryManager, Movie/BoxSet services, NFO/XML, ffprobe, CollectionManager and eight real post-scan tasks, repeated independently; production PG imports the identical frozen full-schema preparation input.',
    unmetPrerequisites: ['This bounded scenario does not establish complete-library coverage, production scale, HTTP authorization, real stopped-instance migration or final release acceptance.'] };
  try {
    capture = await captureMovieGlobal();
    candidate = await runMovieCandidate(capture);
    const specification = JSON.parse(await readFile(new URL('./fixtures/movie-global-native/input.json', import.meta.url), 'utf8'));
    const runs = [['native-first', capture.first], ['native-repeat', capture.repeat], ['postgres', candidate]];
    for (const [name, record] of runs) {
      assert.equal(record.observations.length, 6, name);
      assert.deepEqual(record.observations.map(value => [value.phase, value.boundary]), specification.phases
        .flatMap(phase => [[phase, 'global-returned'], [phase, 'metadata-drained']]));
      if (name.startsWith('native')) {
        assert.equal(record.fullSchemaCloned, true); assert.equal(record.schemaCreated, false);
        assert.equal(record.preparationExecutedAsBusiness, false); assert.equal(record.protectedInputsUnchanged, true);
        assert.equal(record.failure, null);
        assert.deepEqual(record.trace.filter(value => value.action === 'log' && ['Error', 'Critical'].includes(value.detail.level)), [],
          'Caught native dependency/task errors must not become false expected output.');
        assert.deepEqual(record.releasedResources, ['scheduler', 'provider', 'media-encoder', 'image-processor',
          'recordings-manager', 'plugins', 'services', 'cache-and-tokens']);
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
      try { report.projections[name] = projectMovieRun(record, specification); }
      catch (error) { report.projections[name] = { failure: { name: error.name, message: error.message, stack: error.stack } }; }
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
