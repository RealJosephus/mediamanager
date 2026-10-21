import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { makeInput } from './fixtures/live-tv-media-sources/input.js';
import { openScenario, projectSource } from './fixtures/live-tv-media-sources/scenario.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n';
async function within(promise, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for ' + description + '.')), 30000);
  })]); } finally { clearTimeout(timer); }
}

test('default Live TV source discovery and actual playback selection match native provider and MediaSourceManager without opening a stream', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const input = makeInput(), bytes = Buffer.from(encode(input));
  const output = path.join(validationOutputRoot(), 'live-tv-media-sources-' + randomUUID()); await mkdir(output);
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes, { flag: 'wx' });
  const report = { comparisons: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false };
  let current, fixture, failure;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'src/Jellyfin.LiveTv/LiveTvMediaSourceProvider.cs', 'src/Jellyfin.LiveTv/DefaultLiveTvService.cs',
      'src/Jellyfin.LiveTv/TunerHosts/TunerHostManager.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Controller/Entities/UserItemData.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs',
      'MediaBrowser.Model/Entities/MediaStream.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/User.cs',
    ]);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-media-sources/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(receipt.passed, true); assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const flag of ['actualDefaultService', 'actualLiveTvMediaSourceProvider', 'actualMediaSourceManager',
      'actualChannelAndBaseItemMapper', 'constructorTimerSubscriptionBypassed', 'tunerResponsesControlled', 'userDataLookupControlled']) assert.equal(native[flag], true, flag);
    for (const flag of ['nativePersistenceOpened', 'recordingExecutorsStarted', 'mediaStreamsOpened', 'mediaProbeEnabled']) assert.equal(native[flag], false, flag);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.deepEqual(native.results.map(value => value.name), input.cases.map(value => value.name));
    report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    report.thirdPartyNativeOnly = native.thirdPartyNativeOnly;
    assert.equal(native.thirdPartyNativeOnly.SupportsTranscoding, true);
    assert.equal(native.thirdPartyNativeOnly.MediaStreams[0].NalLengthSize, '0');
    assert.equal(native.thirdPartyNativeOnly.MediaStreams[0].IsInterlaced, true);
    fixture = await openScenario(input);
    for (const sample of input.cases) await t.test(sample.name, { timeout: 60000 }, async () => {
      const expected = native.results.find(value => value.name === sample.name), record = { name: sample.name, passed: false };
      report.comparisons.push(record);
      const scenario = await fixture.prepare(sample, expected);
      try {
        assert.equal(expected.enableRememberingTrackSelections, false);
        const dynamic = await scenario.discover(), dynamicSources = dynamic.map(projectSource);
        const dynamicErrors = [...scenario.errors], calls = [...scenario.calls];
        // Snapshot first: the real playback consumer is allowed to set user
        // indices, scores and playback policy on these same dynamic objects.
        const actual = { staticSources: scenario.staticSources, dynamicSources,
          playbackSources: (await scenario.playback(dynamic)).map(projectSource), errors: dynamicErrors, calls };
        record.actual = actual; record.native = expected;
        assert.deepEqual(actual.staticSources, expected.staticSources);
        assert.deepEqual(actual.dynamicSources, expected.dynamicSources);
        assert.deepEqual(actual.playbackSources, expected.playbackSources);
        assert.equal(actual.errors.length, expected.dynamicErrors.length, 'Native manager and Node both observe the suppressed provider error.');
        assert.equal(expected.playbackErrors.length, expected.dynamicErrors.length, 'Independent native dynamic/playback executions observe the same failure.');
        assert.deepEqual(calls, expected.calls.filter(value => value.stage === 'dynamic').map(({ id, cancelled }) => ({ id, cancelled })));
        assert.ok(actual.playbackSources.every(source => source.Type !== 'Placeholder'));
        record.owners = await scenario.assertUnchanged(); record.passed = true;
      } catch (error) { record.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
      finally { await scenario.close(); }
    });
    await t.test('close drains an admitted tuner response and its later real SQL fallback without aborting the caller', { timeout: 60000 }, async () => {
      const sample = input.cases.find(value => value.name.startsWith('empty default-service'));
      const expected = native.results.find(value => value.name === sample.name);
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      let running, closing, drained = false, observedSignal;
      const scenario = await fixture.prepare(sample, expected, { beforeSources: async ({ signal }) => {
        observedSignal = signal; entered.resolve(); await release.promise;
      } });
      try {
        running = scenario.discover();
        await within(Promise.race([entered.promise, running.then(() => { throw new Error('Discovery ended before entering the held tuner response.'); })]), 'held tuner admission');
        closing = scenario.service.close().then(() => { drained = true; });
        assert.equal(scenario.service.close(), scenario.service.close());
        assert.equal(drained, false); assert.equal(observedSignal.aborted, false);
        await assert.rejects(scenario.discover(), { status: 503 });
        release.resolve();
        const value = await running; assert.deepEqual(value.map(projectSource), expected.dynamicSources);
        await closing; assert.equal(drained, true); assert.equal(observedSignal.aborted, false);
        await assert.rejects(scenario.discover(), { status: 503 });
        report.heldClose = { admittedSqlFallbackCompleted: true, callerSignalRetained: true,
          rejectedLaterCalls: true, owners: await scenario.assertUnchanged() };
      } finally { release.resolve(); await Promise.allSettled([running, closing]); await scenario.close(); }
    });
  } catch (error) { failure = error; report.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    for (const [name, action] of [['fixtureClosed', () => fixture?.close()], ['protectedInputsUnchanged', () => current?.finish()]]) {
      try { await action(); report.cleanup.push({ name, passed: true }); }
      catch (error) { failure ??= error; report.cleanup.push({ name, passed: false, message: error.message }); }
    }
    report.boundary = 'Actual native default-service reader, LiveTvMediaSourceProvider (including Normalize), MediaSourceManager dynamic/key/playback consumers, channel and BaseItemMapper. Native tuner responses, user-data lookup and user identities/policy are explicit controls; no native EF database, probing, recording or stream open executes. Node uses the real LiveTvMediaSources and typed SQL item/static-source/UserData/default-track/policy/sort path. Raw provider output is retained separately from the manager-prefixed dynamic comparison. Third-party Normalize is native-only observation; this does not claim a Node third-party service producer, tuner/SDK boundary, HTTP playback, open/close-stream or release acceptance.';
    report.passed = !failure && report.comparisons.length === input.cases.length && report.comparisons.every(value => value.passed) && Boolean(report.heldClose);
    await writeFile(path.join(output, 'comparison.json'), encode(report));
  }
  if (failure) throw failure;
  assert.equal(report.passed, true);
});
