import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { makeInput } from './fixtures/channel-items/input.js';
import { cacheObservation, comparable, errorRecord, hash, openScenario, removeOwned, within } from './fixtures/channel-items/scenario.js';
import { projectChannelAction, projectChannelEntitySummaries } from '../helpers/channel-observation-projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
test('actual Channel Items and Latest preserve cache, repository selection and sequential effects', { skip: !enabled, timeout: 900000 }, async t => {
  const output = path.join(validationOutputRoot(), 'channel-items-' + randomUUID());
  const privateRoot = path.join(output, 'private'); await mkdir(privateRoot, { recursive: true });
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input)); const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], hardFailures: [], cleanup: {}, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    boundary: { native: ['actual ChannelManager cache/materializer/Items/Latest', 'actual LibraryManager', 'actual EF SQLite repository/typed mapper', 'actual DtoService'],
      node: ['PluginHost/SDK', 'real PostgreSQL selections/temporary snapshots', 'ItemCreationService/repository updates/deletion', 'typed DTO/source cache'],
      controlled: ['provider responses', 'metadata RefreshSingleItem and QueueRefresh execution', 'readonly user data'],
      excluded: ['full native MVC/production SQLite migration', 'metadata probe/image execution', 'media stream open', 'recording', 'encoding'] } };
  let current, failure;
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
  const run = (name, work) => t.test(name, { timeout: 180000 }, async () => { try { await work(); } catch (error) { report.hardFailures.push({ name, error: errorRecord(error) }); throw error; } });
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Channels/ChannelManager.cs', 'Jellyfin.Api/Controllers/ChannelsController.cs',
      'MediaBrowser.Controller/Channels/ChannelItemInfo.cs', 'MediaBrowser.Controller/Channels/ChannelItemResult.cs', 'MediaBrowser.Controller/Channels/IHasCacheKey.cs',
      'MediaBrowser.Controller/Channels/ISupportsLatestMedia.cs', 'MediaBrowser.Controller/Channels/ISupportsMediaProbe.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs', 'Jellyfin.Api/Helpers/RequestHelpers.cs',
      'src/Jellyfin.Extensions/ReadOnlyListExtension.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-items/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] }); assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes)); assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const field of ['actualChannelManager', 'actualRepositoryAndTypedMapper', 'actualEfPersistence', 'actualRawSqliteBeforeRows', 'actualDtoService', 'actualControllerActions']) assert.equal(native[field], true, field);
    assert.equal(native.mediaExecutionStarted, false); assert.equal(native.sqliteNative.explicitResolver, true);
    for (const assembly of [...native.assemblies, native.sqliteNative]) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    for (const [index, sample] of input.cases.entries()) await run(sample.name, async () => {
      const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.steps.length, sample.steps.length);
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-' + index));
      try {
        const observations = [];
        for (const [stepIndex, step] of sample.steps.entries()) {
          const nativeStep = expected.steps[stepIndex];
          if (step.failure) assert.equal(nativeStep.action.failure?.status, step.failure, 'The actual native error must occur at the declared input.');
          else assert.equal(nativeStep.action.failure, undefined, 'Every declared native success must execute its real dependencies: ' + stringifyNativeJson(nativeStep.action));
          if (sample.name === 'Latest presentation grouping requires a user' && step.kind === 'latest') assert.equal(nativeStep.action.value.Items.length, step.user ? 1 : 2);
          if (sample.name === 'empty Latest channel filter retains the native all-library query') {
            assert.equal(nativeStep.action.value.Items.length, 2); assert.ok(nativeStep.action.value.Items.some(item => item.Name === 'Retained ordinary media'));
          }
          const actual = await fixture.step(step);
          compare(sample.name + ':' + stepIndex + ': actual action', projectChannelAction(comparable(actual.action), fixture.root), projectChannelAction(comparable(nativeStep.action), expected.root));
          for (const field of ['persisted', 'warm']) compare(sample.name + ':' + stepIndex + ': ' + field,
            projectChannelEntitySummaries(actual[field], fixture.root), projectChannelEntitySummaries(nativeStep[field], expected.root));
          for (const field of ['calls', 'queue']) compare(sample.name + ':' + stepIndex + ': ' + field, actual[field], nativeStep[field]);
          for (const field of ['cacheFiles', 'mediaFiles']) compare(sample.name + ':' + stepIndex + ': ' + field,
            cacheObservation(actual[field]), cacheObservation(nativeStep[field]));
          if (step.kind === 'items' || step.kind === 'latest') {
            assert.ok(actual.calls.filter(value => value.kind === 'items').every(value => value.SortBy === null && value.SortDescending === false && value.StartIndex === null && value.Limit === null));
          }
          await fixture.released(); observations.push(actual);
        }
        assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        report.comparisons.push({ name: sample.name, observations, expected });
      } finally { await fixture.close(); }
    });
    await run('already admitted Items holds Library and Channel during provider await', async () => {
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers(); let fixture, pending, channelsClosing, libraryClosing;
      try {
        fixture = await openScenario(input.cases[0], native.results[0], path.join(privateRoot, 'held'), { fetching: async () => { entered.resolve(); await proceed.promise; } });
        pending = fixture.step(input.cases[0].steps[0]); void pending.catch(() => {});
        await within(entered.promise, 'actual installed provider callback');
        let channelsClosed = false, libraryClosed = false;
        channelsClosing = fixture.channels.close().then(() => { channelsClosed = true; });
        libraryClosing = fixture.library.close().then(() => { libraryClosed = true; }); fixture.metadata.cancel();
        await assert.rejects(fixture.channels.getChannelItems({}), { status: 503 });
        assert.equal(channelsClosed, false); assert.equal(libraryClosed, false);
        proceed.resolve(); const result = await within(pending, 'admitted SQL/materializer result');
        assert.equal(result.action.failure, undefined); assert.equal(result.action.value.Items.length, 5);
        await within(Promise.all([channelsClosing, libraryClosing]), 'both admitted operation owners');
        assert.equal(channelsClosed, true); assert.equal(libraryClosed, true); assert.deepEqual(fixture.diagnostics, []);
        report.comparisons.push({ name: 'held Channel and Library ownership', result, channelsClosed, libraryClosed });
      } finally { proceed.resolve(); await Promise.allSettled([pending, channelsClosing, libraryClosing]); await fixture?.close(); }
    });
    assert.deepEqual(report.hardFailures, [], stringifyNativeJson(report.hardFailures)); assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    report.failure = failure ? errorRecord(failure) : null; const errors = [];
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { errors.push(error); }
    try { await removeOwned(output, privateRoot); report.cleanup.private = true; } catch (error) { errors.push(error); }
    if (errors.length) { report.componentAcceptance = false; report.cleanup.errors = errors.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value, 2)); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Channel Items cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
