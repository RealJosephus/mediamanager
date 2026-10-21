import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { readNativeMediaSourceInfoList } from '../../src/playback/live-stream-info.js';
import { normalizeChannelMediaSources, readChannelStaticMediaSources, channelMediaSourceCachePath } from '../../src/library/channel-static-media-sources.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { idKey } from '../../src/library/records.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { makeInput } from './fixtures/channel-static-media-sources/input.js';
import { canonicalSourceObservation, errorRecord, hash, observe, openScenario, projectDto, projectSource, within } from './fixtures/channel-static-media-sources/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('saved Channel media sources match actual file reader, normalization, BaseItem, MediaSourceManager and DTO consumers with real PostgreSQL', {
  skip: !enabled, timeout: 600000,
}, async () => {
  const input = makeInput(), bytes = Buffer.from(stringifyNativeJson(input));
  const output = path.join(validationOutputRoot(), 'channel-static-media-sources-' + randomUUID()); await mkdir(output);
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const privateRoot = path.join(output, 'private-native');
  const report = { comparisons: [], normalization: [], differences: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  let current, fixture, failure;
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); }
  };
  const comparable = value => value.failure ? { failure: { status: value.failure.status,
    ...(value.failure.status === 400 ? { Message: value.failure.Message } : {}) } } : { value: value.value };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Channels/ChannelManager.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/Channels/Channel.cs',
      'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
      'Emby.Server.Implementations/Library/MediaStreamSelector.cs', 'Jellyfin.Data/UserEntityExtensions.cs', 'src/Jellyfin.Extensions/ReadOnlyListExtension.cs',
      'MediaBrowser.Controller/Library/VersionPlaybackSelector.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs',
      'MediaBrowser.Model/Entities/MediaStream.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-static-media-sources/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json', privateRoot] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(receipt.passed, true); assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const flag of ['actualChannelManagerSavedReader', 'actualBaseItemMediaSources', 'actualMediaSourceManager', 'actualDtoService', 'actualTypedMapper', 'nativeLibraryAndUserDataLookupsControlled']) assert.equal(native[flag], true, flag);
    for (const flag of ['nativeDatabaseOpened', 'originalMediaOpened', 'recordingOrTranscodingStarted']) assert.equal(native[flag], false, flag);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    fixture = await openScenario(input);
    for (const [index, sample] of input.cases.entries()) {
      const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.cacheSha256After, expected.cacheSha256);
      for (const stage of ['direct', 'baseSources', 'staticSources', 'playbackSources', 'dto']) {
        const allowed = sample.expectedNativeFailures?.[stage], error = expected[stage].failure;
        if (!allowed) assert.equal(error, undefined, sample.name + ': ' + stage + ' must succeed with every readonly native dependency bound: ' + stringifyNativeJson(error));
        else {
          assert.ok(error, sample.name + ': ' + stage + ' must exercise its explicit invalid input.');
          assert.equal(error.type, allowed.type); assert.equal(error.status, allowed.status);
          if (allowed.Message) assert.equal(error.Message, allowed.Message);
          if (allowed.stackIncludes) assert.ok(error.StackTrace.includes(allowed.stackIncludes), stringifyNativeJson(error));
        }
      }
      if (sample.expectFallback) {
        assert.deepEqual(expected.direct.value, []);
        for (const stage of ['baseSources', 'staticSources', 'playbackSources']) {
          assert.equal(expected[stage].value.length, 1); assert.equal(expected[stage].value[0].Path, path.join(expected.root, 'original.mkv'));
          assert.equal(expected[stage].value[0].Protocol, 'File');
        }
        assert.equal(expected.dto.value.MediaSources.length, 1); assert.equal(expected.dto.value.MediaSources[0].Path, path.join(expected.root, 'original.mkv'));
      }
      const scenario = await fixture.prepare(sample, expected);
      assert.equal(channelMediaSourceCachePath(scenario.item, expected.metadataPath), expected.cachePath);
      const actual = { name: sample.name, direct: await observe(() => readChannelStaticMediaSources(scenario.item, { metadataPath: expected.metadataPath, fileSystem: testFileSystem })),
        baseSources: await observe(scenario.base), staticSources: await observe(scenario.static), playbackSources: await observe(scenario.playback),
        dto: await observe(scenario.dto), liveSources: await observe(scenario.live) };
      for (const stage of ['direct', 'baseSources', 'staticSources', 'playbackSources']) compare(sample.name + ': ' + stage,
        comparable(canonicalSourceObservation(actual[stage])), comparable(canonicalSourceObservation(expected[stage])));
      compare(sample.name + ': readonly getLiveMediaSources', comparable(canonicalSourceObservation(actual.liveSources)), comparable(canonicalSourceObservation(expected.baseSources)));
      const actualDto = actual.dto.failure ? actual.dto : { value: projectDto(actual.dto.value) };
      const expectedDto = expected.dto.failure ? expected.dto : { value: { ...expected.dto.value,
        MediaSources: expected.dto.value.MediaSources?.map(projectSource) ?? null, MediaStreams: expected.dto.value.MediaStreams ?? null,
        MediaSourceCount: expected.dto.value.MediaSourceCount ?? null } };
      compare(sample.name + ': DTO/source stream/count/channel name', comparable(actualDto), comparable(expectedDto));
      actual.owners = await scenario.assertUnchanged(); report.comparisons.push({ ...actual, native: expected });
      await writeFile(path.join(output, 'progress.json'), stringifyNativeJson(report) + '\n');
    }
    for (const [index, sample] of input.normalizeCases.entries()) {
      const item = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Video'), { Id: input.itemId, RunTimeTicks: 60000000000n });
      const sources = readNativeMediaSourceInfoList(Buffer.from(stringifyNativeJson(sample)));
      const result = await observe(() => normalizeChannelMediaSources(item, sources));
      compare('normalization failure/mutation ' + index, comparable(canonicalSourceObservation(result)), comparable(canonicalSourceObservation(native.normalization[index].result)));
      compare('normalization mutated prefix ' + index, sources.map(projectSource), native.normalization[index].after.map(projectSource));
      report.normalization.push({ result, after: sources });
    }
    report.pathCases = [];
    for (const sample of native.pathCases) {
      const item = Object.assign(newNativeItemEntity(sample.nativeType), { Id: sample.id, ChannelId: sample.channelId });
      const actual = channelMediaSourceCachePath(item, sample.metadataPath); assert.equal(actual, sample.expectedPath);
      report.pathCases.push({ ...sample, actual });
    }
    report.dtoCases = [];
    for (const sample of native.dtoCases) {
      const item = Object.assign(newNativeItemEntity(sample.nativeType), { Id: input.itemId, ChannelId: sample.channelId, Name: 'Unselected display' });
      const actual = await observe(() => fixture.database.withConnection(async db => {
        const state = await fixture.library.load(db, null, { baseRows: [] });
        try {
          state.items.push(item); state.byId.set(idKey(item.Id), item);
          const dto = await projectItem(item, state, null, dtoOptions({ enableimages: false, enableuserdata: false }), fixture.library.options);
          return { SourceType: dto.SourceType ?? null, ChannelName: dto.ChannelName ?? null, EnableMediaSourceDisplay: dto.EnableMediaSourceDisplay ?? null };
        } finally { await state.dispose({ session: db }); }
      }));
      compare('unselected display and final ChannelName lookup: ' + sample.nativeType + ':' + sample.channelId, comparable(actual), comparable(sample.result));
      report.dtoCases.push({ ...sample, actual });
    }
    assert.ok(fixture.sourceQueries.some(value => value.ids.length === 128));
    assert.ok(fixture.sourceQueries.every(value => value.ids.length <= 128), 'Saved input IDs must be queried in bounded SQL batches.');
    report.sourceQueries = fixture.sourceQueries;
    const heldIndex = input.cases.findIndex(sample => sample.name === 'one empty id receives item id');
    const held = await fixture.prepare(input.cases[heldIndex], native.results[heldIndex]);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let handlesClosed = 0, closing, pending, closeSettled = false;
    fixture.library.options.fileSystem = new Proxy(testFileSystem, { get(target, key) {
      if (key === 'openRead') return async (...args) => {
        const handle = await target.openRead(...args); entered.resolve(); await release.promise;
        let disposed; return { ...handle, close() { return disposed ??= Promise.resolve().then(async () => { handlesClosed++; await handle.close(); }); } };
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      pending = observe(held.live); await within(entered.promise, 'admitted metadata cache reader');
      closing = fixture.library.close(); closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
      await assert.rejects(fixture.library.getLiveMediaSources(held.item), { status: 503 }); assert.equal(closeSettled, false);
      release.resolve();
      const result = await within(pending, 'held saved source read');
      compare('admitted saved read survives library close', comparable(canonicalSourceObservation(result)), comparable(canonicalSourceObservation(native.results[heldIndex].baseSources)));
      await within(closing, 'library saved reader drain'); assert.equal(handlesClosed, 1); await held.assertUnchanged();
      report.heldClose = { handleClosed: handlesClosed, rejectedNewAdmission: true, oldAdmissionCompleted: !result.failure };
    } finally {
      release.resolve(); fixture.library.options.fileSystem = testFileSystem;
      await Promise.allSettled([pending, closing]);
    }
    assert.deepEqual(report.differences, [], 'Every actual native saved-cache consumer and candidate SQL result must agree.');
  } catch (error) { failure = error; }
  finally {
    for (const [name, action] of [['nodeOwnersClosed', () => fixture?.close()], ['protectedInputsUnchanged', () => current?.finish()],
      ['privateInputsRemoved', async () => {
        assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-native'); await rm(privateRoot, { recursive: true, force: true });
      }]]) try { await action(); report.cleanup[name] = true; } catch (error) { failure ??= error; report.cleanup[name] = false; }
    report.passed = !failure; if (failure) report.error = errorRecord(failure);
    await writeFile(path.join(output, 'comparison.json'), stringifyNativeJson(report) + '\n');
  }
  if (failure) throw failure;
});
