import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { makeInput } from './fixtures/channel-parent-latest/input.js';
import { comparable, errorRecord, hash, normalize, openScenario, removeOwned } from './fixtures/channel-parent-latest/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const id = value => String(value).replaceAll('-', '').toLowerCase();
const userData = rows => rows.map(row => ({ ItemId: id(row.ItemId), UserId: id(row.UserId), CustomDataKey: row.CustomDataKey,
  Played: row.Played, PlayCount: row.PlayCount, PlaybackPositionTicks: BigInt(row.PlaybackPositionTicks) }))
  .sort((left, right) => (left.ItemId + left.CustomDataKey).localeCompare(right.ItemId + right.CustomDataKey));

test('Channel parent Items/Latest matches current Native refresh, user filtering, bounded grouping and public DTOs', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'channel-parent-latest-' + randomUUID());
  const privateRoot = path.join(output, 'private'); await mkdir(privateRoot, { recursive: true });
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input));
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], failures: [], cleanup: {}, componentAcceptance: false,
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Actual UserLibraryController and UserViewManager Channel-parent Latest, ChannelManager refresh, SQLite repository/EF and DtoService versus Node HTTP and PostgreSQL. Controlled provider payloads, metadata execution and user-data setup. No Native MVC binding, media execution or complete instance migration claim.' };
  let current, failure;
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); }
  };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Channels/ChannelManager.cs',
      'Emby.Server.Implementations/Library/UserViewManager.cs', 'Jellyfin.Api/Controllers/UserLibraryController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'MediaBrowser.Controller/Channels/ChannelItemInfo.cs', 'Jellyfin.Api/Helpers/RequestHelpers.cs',
      'MediaBrowser.Controller/Entities/Audio/Audio.cs', 'MediaBrowser.Controller/Entities/TV/Episode.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/InternalItemsQuery.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-parent-latest/current/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const field of ['actualChannelManager', 'actualUserViewManager', 'actualRepositoryAndTypedMapper', 'actualEfPersistence',
      'actualRawSqliteBeforeRows', 'actualDtoService', 'actualControllerActions']) assert.equal(native[field], true);
    for (const assembly of [...native.assemblies, native.sqliteNative]) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    for (const [index, sample] of input.cases.entries()) await t.test(sample.name, { timeout: 240000 }, async () => {
      const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.steps.length, sample.steps.length);
      let fixture;
      try {
        fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-' + index));
        const observations = [];
        for (const [stepIndex, step] of sample.steps.entries()) {
          const original = expected.steps[stepIndex];
          assert.equal(original.action.failure, undefined, 'The actual Native consumer must complete: ' + stringifyNativeJson(original.action));
          const actual = await fixture.step(step);
          compare(sample.name + ':' + stepIndex + ': public result', normalize(comparable(actual.action), fixture.root),
            normalize(comparable(original.action), expected.root));
          compare(sample.name + ':' + stepIndex + ': persisted music/video/channel values', normalize(actual.persisted, fixture.root), normalize(original.persisted, expected.root));
          compare(sample.name + ':' + stepIndex + ': provider reads', normalize(actual.calls, fixture.root), normalize(original.calls, expected.root));
          compare(sample.name + ':' + stepIndex + ': persisted user state', userData(actual.userData), userData(original.userData));
          if (step.kind === 'parent-latest') {
            assert.equal(actual.wire?.status, 200);
            assert.match(actual.wire.contentType, /^application\/json\b/u);
            assert.deepEqual(actual.wire.diagnostics, []);
          }
          if (step.name === 'single audio still returns album') {
            assert.equal(original.action.value.length, 1); assert.equal(original.action.value[0].Type, 'MusicAlbum');
            assert.equal(original.action.value[0].ChildCount, 1);
          }
          if (step.name === 'two audio tracks count within candidate cap') assert.equal(original.action.value[0].ChildCount, 2);
          if (step.name === 'two episodes return series' || step.name === 'grouped series skips second visibility pass') {
            assert.equal(original.action.value.length, 1); assert.equal(original.action.value[0].Type, 'Series');
            assert.equal(original.action.value[0].ChildCount, 2);
          }
          if (['zero limit', 'folder type cannot evade IsFolder false', 'blocked Series tags also block Episodes', 'no latest marker', 'no installed provider'].includes(step.name))
            assert.deepEqual(original.action.value, []);
          observations.push(actual);
        }
        assert.ok(observations.every(value => value.calls.every(call => call.FolderId !== 'unrefreshed-deep')),
          'Latest refresh must stop after the actual root and its immediate folders.');
        assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        report.comparisons.push({ name: sample.name, observations, expected });
      } catch (error) { report.failures.push({ name: sample.name, error: errorRecord(error) }); throw error; }
      finally { await fixture?.close(); }
    });
    assert.deepEqual(report.failures, [], stringifyNativeJson(report.failures));
    assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    report.failure = failure ? errorRecord(failure) : null; const errors = [];
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { errors.push(error); }
    try { await removeOwned(output, privateRoot); report.cleanup.private = true; } catch (error) { errors.push(error); }
    if (errors.length) { report.componentAcceptance = false; report.cleanup.errors = errors.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report,
      (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value, 2)); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
      failure?.message ?? 'Channel parent Latest cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
