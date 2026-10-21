import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupScenario, sortedProgress, verifyWindows } from './fixtures/live-tv-guide-refresh/scenario.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const inputFile = new URL('./fixtures/live-tv-guide-refresh/input.json', import.meta.url);
const bytes = await readFile(inputFile), input = JSON.parse(bytes), hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n';
const comparison = run => ({ trace: run.trace, progress: sortedProgress(run.progress), error: run.error, items: run.items });

test('guide refresh orchestration matches actual native RefreshGuide through real PostgreSQL repository and ownership lifecycles', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'live-tv-guide-refresh-' + randomUUID()); await mkdir(output);
  const report = { comparisons: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false };
  let current, failure;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'src/Jellyfin.LiveTv/Guide/GuideManager.cs', 'src/Jellyfin.LiveTv/LiveTvDtoService.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Controller/LiveTv/ILiveTvService.cs',
    ]);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-guide-refresh/Oracle.csproj', output: path.join(output, 'native'),
      args: [fileURLToPath(inputFile), '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(receipt.passed, true); assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const flag of ['actualGuideManagerRefreshGuide', 'actualPrivateMaterializers', 'actualLiveTvDtoIdentity', 'actualBaseItemMapperFrames',
      'nativePersistenceControlled', 'nativeMetadataProviderControlled', 'nativeRepositorySelectionControlled', 'nonDefaultServicesOnly']) assert.equal(native[flag], true, flag);
    assert.equal(native.nativeEfOpened, false); assert.equal(native.recordingExecutorsStarted, false);
    assert.deepEqual(native.results.map(value => value.name), input.cases.map(value => value.name));
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const sample of input.cases) await t.test(sample.name, { timeout: 180000 }, async t => {
      const record = { name: sample.name, runs: [], passed: false }; report.comparisons.push(record);
      try {
        const fixture = await setupScenario(t, sample), expected = native.results.find(value => value.name === sample.name);
        assert.equal(expected.runs.length, sample.progressCounts.length);
        for (const [index, progressCount] of sample.progressCounts.entries()) {
          const actual = await fixture.run(), reference = expected.runs[index];
          record.runs.push({ actual, reference });
          assert.equal(reference.progress.length, progressCount, 'Every asynchronously dispatched native progress callback must be observed.');
          assert.equal(actual.progress.length, progressCount);
          verifyWindows(reference, sample.guideDays); verifyWindows(actual, sample.guideDays);
          assert.deepEqual(comparison(actual), comparison(reference), sample.name + ' refresh ' + (index + 1));
          assert.ok(actual.sqlPages.every(count => count <= 128));
          assert.equal(actual.owners.metadataContexts, 0); assert.equal(actual.owners.configurationAdmissions, 0);
          assert.equal(actual.owners.sqlStates, 0); assert.equal(actual.owners.sqlCohorts, 0); assert.equal(actual.owners.temporaryTables, 0);
          if (sample.failChannel || sample.services.some(service => service.failChannels) || sample.name.includes('null genres') || sample.name.includes('duplicate existing GUID')) {
            assert.equal(actual.trace.some(value => value.kind === 'clean'), false, 'A partial refresh must not clean unrelated prior data.');
          }
          if (sample.name.includes('null genres')) {
            assert.equal(actual.items.some(item => item.ExternalId?.startsWith('broken-prefix-')), false, 'Late materialization failure saves none of the 130 earlier new programs.');
            assert.ok(actual.items.some(item => item.ExternalId === 'stale-program'));
          }
          if (sample.preCancelled) assert.deepEqual(actual.trace, [{ kind: 'folders' }]);
        }
        await fixture.guide.close(); await fixture.images.close(); await fixture.liveTv.close();
        await assert.rejects(fixture.guide.refresh({ reportProgress() {} }), { status: 503 });
        record.closedOwners = await fixture.assertReleased(); record.passed = true;
      } catch (error) { record.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
    });
  } catch (error) { failure = error; report.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (current) try { await current.finish(); report.cleanup.push({ protectedInputsUnchanged: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ protectedInputsUnchanged: false, message: error.message }); }
    report.passed = !failure && report.comparisons.length === input.cases.length && report.comparisons.every(value => value.passed);
    report.boundary = 'Actual native GuideManager.RefreshGuide/GetChannel/GetProgram/identity/BaseItemMapper; native library rows, metadata provider and repository selection are controlled, with no native EF database. Node uses real PostgreSQL/cohorts/persistence/update/deletion/configuration and mapped image assets. All services are non-Default; recorder/tuner/stream execution and DefaultLiveTvService timer refresh are outside this R6 slice. Exact raw progress order is retained, while asynchronous Progress<double> values compare as a complete multiset. This is targeted component evidence, not Guide or release acceptance.';
    await writeFile(path.join(output, 'comparison.json'), encode(report));
  }
  if (failure) throw failure;
  assert.equal(report.passed, true, 'Every native refresh comparison and resource owner must pass.');
});
