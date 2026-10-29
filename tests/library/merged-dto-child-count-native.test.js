import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { idKey } from '../../src/library/records.js';
import { mergedCountInput, countId } from './fixtures/merged-dto-child-count-current/input.js';
import { errorRecord, openMergedCountScenario, sha } from './fixtures/merged-dto-child-count-current/scenario.js';
import { removePrivateRoot } from '../http/fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sourcePaths = [
  'Jellyfin.Server.Implementations/Item/ItemCountService.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/DescendantQueryHelper.cs',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/TV/Series.cs', 'MediaBrowser.Controller/Entities/TV/Season.cs',
  'Emby.Server.Implementations/Localization/LocalizationManager.cs',
];
const projection = result => ({ name: result.name, lane: result.lane, user: result.user,
  counts: result.counts.map(entry => ({ ...entry, id: idKey(entry.id) })).sort((a, b) => a.id.localeCompare(b.id, 'en')) });

test('current native persisted presentation-key child-count batches repeat independently and match production PostgreSQL merged Series/Season consumers', {
  skip: !enabled, timeout: 720000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'merged-dto-child-count-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output, { recursive: true });
  const temporaryParent = await realpath(tmpdir());
  const privateRoot = await realpath(await mkdtemp(path.join(temporaryParent, 'mm-merged-count-')));
  const input = mergedCountInput(path.join(privateRoot, 'controlled-root'));
  const inputFile = path.join(output, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), captures: [], cases: [], differences: [], cleanup: {},
    scope: 'Actual same-run SQLite ItemCountService plus private DtoService count-source/batch/single consumers, independently repeated; real transferred PostgreSQL users/repository/library count consumers. No full DTO/MVC/playback/recording execution claim.',
    phaseAcceptance: false, releaseAcceptance: false };
  let current, protectedSource, first, fixture, failed = false, failure;
  const unchanged = async (filename, expected) => {
    const actual = await describeFile(filename); assert.equal(actual.available, true); assert.equal(actual.sha256, expected, filename); return actual;
  };
  const save = async () => {
    let serialized = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    if (process.env.MEDIAMANAGER_TEST_POSTGRES) serialized = serialized.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]');
    await writeFile(path.join(output, 'report.json'), serialized + '\n');
  };
  try {
    await mkdir(input.root); await writeFile(inputFile, inputBytes);
    current = await currentNativeReference(); report.preparation = current.preparation;
    protectedSource = await describeFile(current.sourceDatabase); report.sourceDatabase = protectedSource;
    report.sourceBindings = await current.sourceBindings(sourcePaths);
    for (const label of ['first', 'repeat']) {
      const receipt = await recordOracle({ project: 'tests/library/fixtures/merged-dto-child-count-current/Oracle.csproj',
        output: path.join(output, label), environment: current.environment,
        args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native-' + label), current.sourceDatabase] });
      assert.equal(receipt.passed, true); assert.equal(receipt.build.status, 0); assert.equal(receipt.process.status, 0);
      const nativeFilename = path.join(output, label, 'native.json'), bytes = await readFile(nativeFilename), native = JSON.parse(bytes);
      const capture = { label, receipt, output: await describeFile(nativeFilename), runtimeBindings: [] }; report.captures.push(capture);
      assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.sourceSha256, protectedSource.sha256);
      assert.equal(receipt.outputs.find(entry => entry.filename === nativeFilename).sha256, sha(bytes));
      for (const flag of ['actualItemCountService', 'actualDtoCountBatch', 'actualDtoSingleCount',
        'actualRepositoryAndTypedMapper', 'actualEfSqlite', 'schemaHistoryPreserved']) assert.equal(native[flag], true, flag);
      for (const flag of ['schemaCreated', 'actualFullDtoOrHttpExecuted', 'recordingOrMediaExecution', 'phaseAcceptance', 'releaseAcceptance']) assert.equal(native[flag], false, flag);
      assert.equal(native.preparation.cloneSha256, protectedSource.sha256);
      assert.equal(native.preparation.foreignKeys.enabled, true); assert.deepEqual(native.preparation.foreignKeys.violations, []);
      const schema = JSON.parse(native.preparation.schemaJson); assert.equal(schema.length, 2);
      assert.ok(schema.every(part => part.length > 0)); assert.deepEqual(native.before, native.after);
      assert.deepEqual(native.results.map(entry => entry.name), input.cases.map(entry => entry.name));
      const get = (name, number) => native.results.find(entry => entry.name === name).counts.find(entry => idKey(entry.id) === idKey(countId(number)))?.count;
      const all = get('actual repository batch all', 10), limited = get('actual repository batch limited', 10);
      assert.ok(all > 128); assert.ok(limited > 128 && limited < all);
      for (const number of [11, 12, 13]) assert.equal(get('actual repository batch all', number), all,
        'Request keys find all matching Folder members; the requested type is not a member filter.');
      assert.equal(get('actual repository batch all', 14), 1);
      assert.equal(get('actual repository batch all', 15), 3);
      assert.equal(get('actual repository batch all', 16), 0, 'A merged zero overrides three accessible link rows.');
      assert.equal(get('actual repository batch all', 17), 0);
      assert.equal(get('actual repository batch all', 19), 1);
      assert.equal(get('actual repository batch all', 70), 1, 'Empty parent keys never merge.');
      assert.equal(get('actual repository batch all', 72), 1);
      assert.equal(get('actual repository batch all', 73), 0, 'Null parent keys never merge.');
      assert.equal(get('actual repository batch all', 30), 4);
      assert.equal(get('actual repository batch limited', 30), 3);
      assert.equal(get('actual repository batch all', 999), 1, 'A valid flat SeasonId source does not require a persisted Season row.');
      assert.equal(get('actual DTO source batch all', 18), all * 3, 'Every repeated physical source occurrence is summed once.');
      assert.equal(get('single DTO batch fallback uses persisted key despite unsaved key', 10), all);
      for (const assembly of native.assemblies) {
        await unchanged(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|Emby\.|MediaBrowser\.)/u.test(assembly.name)) capture.runtimeBindings.push({ name: assembly.name,
          ...await unchanged(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256) });
      }
      for (const name of ['MediaBrowser.Controller', 'Emby.Server.Implementations', 'Jellyfin.Server.Implementations', 'Jellyfin.Database.Implementations']) assert.ok(capture.runtimeBindings.some(entry => entry.name === name));
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        assert.equal(library.loadedByExplicitResolver, true); assert.ok(library.resolverCalls > 0); await unchanged(library.filename, library.sha256);
        capture.runtimeBindings.push(await unchanged(path.join(current.runtimeRoot, 'runtimes', library.rid, 'native', path.basename(library.filename)), library.sha256));
      }
      await unchanged(native.databaseFilename, native.databaseSha256);
      for (const file of receipt.sourceFiles) await unchanged(file.filename, file.sha256);
      if (first) {
        assert.deepEqual(native.results.map(projection), first.results.map(projection));
        assert.deepEqual(native.before, first.before); assert.deepEqual(native.preparation, first.preparation);
        assert.equal(receipt.sourceFilesSha256, report.captures[0].receipt.sourceFilesSha256);
      }
      first ??= native; capture.inputsStable = true; await save();
    }
    report.independentNativeRepeatMatched = true;
    fixture = await openMergedCountScenario(input, first.databaseFilename, report);
    report.before = await fixture.snapshot();
    for (const [index, sample] of input.cases.entries()) {
      const beforeRead = await fixture.snapshot(), actual = await fixture.run(sample), expected = first.results[index];
      const afterRead = await fixture.snapshot(); assert.deepEqual(afterRead, beforeRead, sample.name + ': read-only complete business tables');
      try { assert.deepEqual(projection(actual), projection(expected), sample.name); }
      catch (error) { report.differences.push({ name: sample.name, actual, expected, error: errorRecord(error) }); }
      report.cases.push({ name: sample.name, actual, native: expected }); await save();
    }
    report.after = await fixture.snapshot(); assert.deepEqual(report.after, report.before);
    assert.deepEqual(report.differences, []);
    assert.ok(report.queries.length > 0 && report.queries.every(query => query.returned <= 16));
    report.componentPassed = true;
  } catch (error) { failed = true; failure = error; }
  finally {
    const failures = [], attempt = async (name, action) => {
      try { await action(); report.cleanup[name] = true; }
      catch (error) { failures.push(error); report.cleanup[name] = errorRecord(error); }
    };
    await attempt('postgresLibraryAndRelationOwnersClosed', () => fixture?.close());
    await attempt('protectedNativeInputsUnchanged', () => current?.finish());
    if (protectedSource) await attempt('stoppedDatabaseUnchanged', () => unchanged(protectedSource.filename, protectedSource.sha256));
    await attempt('privateClonesRemovedOutsideArtifacts', () => removePrivateRoot(privateRoot, temporaryParent, 'mm-merged-count-'));
    if (failures.length) {
      failure = new AggregateError(failed ? [failure, ...failures] : failures,
        'Merged count component and cleanup failed.', { cause: failed ? failure : failures[0] });
      failed = true; report.componentPassed = false;
    }
    t.diagnostic(inspect({ runtimeErrors: fixture?.errors }, { depth: null, maxArrayLength: null }));
    report.passed = !failed; report.error = failed ? errorRecord(failure) : null; await save();
  }
  if (failed) throw failure;
});
