import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { nativeModel } from '../../src/database/model.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { folderLinkInput } from './fixtures/user-root-linked-current/folder-input.js';
import { rootLinkId as id } from './fixtures/user-root-linked-current/input.js';
import { errorRecord, files, observedProjection, openRootScenario, sha } from './fixtures/user-root-linked-current/scenario.js';
import { prepareDirectories, removePrivateRoot } from '../http/fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const formatFailures = new Set(['malformed LibraryItemId propagates without caching',
  'malformed identity fails again without a negative cache', 'malformed identity preserves earlier cache publication',
  'a later source reaches malformed collection fallback', 'malformed collection fallback fails again without negative caching',
  'collection Path cache publication precedes malformed fallback']);
const nullFailures = new Set(['typed null links fail before filtering',
  'collection visibility consumes null links before tag rejection']);
const sourcePaths = [
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/LinkedChild.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs',
  'MediaBrowser.Controller/Entities/AggregateFolder.cs', 'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', 'MediaBrowser.Controller/Entities/Video.cs',
  'MediaBrowser.Controller/Entities/ItemImageInfo.cs', 'src/Jellyfin.Drawing/ImageProcessor.cs',
  'MediaBrowser.Controller/Entities/Audio/MusicArtist.cs', 'MediaBrowser.Controller/Dto/DtoOptions.cs',
  'MediaBrowser.Controller/Library/LibraryManagerExtensions.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs', 'Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/UserViewManager.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/ServerApplicationPaths.cs',
  'Emby.Server.Implementations/Collections/CollectionManager.cs',
  'Emby.Server.Implementations/Sorting/SortNameComparer.cs',
  ...['Name', 'DateCreated', 'ProductionYear', 'CommunityRating', 'CriticRating', 'IndexNumber',
    'ParentIndexNumber', 'PremiereDate', 'Runtime', 'IsFolder', 'AiredEpisodeOrder'].map(name => `Emby.Server.Implementations/Sorting/${name}Comparer.cs`),
  'Emby.Server.Implementations/Localization/LocalizationManager.cs',
  'Emby.Server.Implementations/Localization/Ratings/us.json', 'Emby.Server.Implementations/Localization/iso6392.txt',
  'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
];

test('actual Folder.GetItems and PostgreSQL queryItems agree on current links, warm Children, unsaved query fields, paging and shutdown', {
  skip: !enabled, timeout: 720000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'folder-links-current-' + randomUUID()); assertValidationOutputChild(output);
  await mkdir(output, { recursive: true });
  const temporaryParent = await realpath(tmpdir()), privateRoot = await realpath(await mkdtemp(path.join(temporaryParent, 'mm-folder-links-')));
  const input = folderLinkInput(path.join(privateRoot, 'instance')), inputFile = path.join(output, 'input.json');
  const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), captures: [], cases: [], differences: [], cleanup: {},
    scope: input.scope, phaseAcceptance: false, releaseAcceptance: false,
    unmetPrerequisites: ['Full HTTP/auth, every item type and final release acceptance are outside this component.'] };
  let current, sourceDatabase, first, fixture, failure;
  const unchanged = async (filename, expected) => {
    const value = await describeFile(filename); assert.equal(value.available, true); assert.equal(value.sha256, expected, filename); return value;
  };
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); }
  };
  const save = async () => {
    let text = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    if (process.env.MEDIAMANAGER_TEST_POSTGRES) text = text.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]');
    await writeFile(path.join(output, 'report.json'), text + '\n');
  };
  try {
    await writeFile(inputFile, inputBytes); await prepareDirectories(input.root);
    const beforeNativeFiles = await files(input.root);
    current = await currentNativeReference(); report.preparation = current.preparation;
    sourceDatabase = await describeFile(current.sourceDatabase); report.sourceDatabase = sourceDatabase;
    report.sourceBindings = await current.sourceBindings(sourcePaths);
    for (const label of ['first', 'repeat']) {
      const receipt = await recordOracle({ project: 'tests/library/fixtures/user-root-linked-current/Oracle.csproj',
        output: path.join(output, label), environment: current.environment,
        args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native-' + label), current.sourceDatabase] });
      const filename = path.join(output, label, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      const captured = { label, receipt, output: await describeFile(filename), runtimeBindings: [] }; report.captures.push(captured);
      assert.equal(receipt.passed, true); assert.equal(receipt.build.status, 0); assert.equal(receipt.process.status, 0);
      assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.sourceSha256, sourceDatabase.sha256);
      assert.equal(receipt.outputs.find(row => row.filename === filename).sha256, sha(bytes));
      for (const flag of ['actualRepositoryAndTypedMapper', 'actualLinkedChildrenService', 'actualFolderGetItems',
        'actualCollectionManager', 'actualDtoService', 'actualReadOnlyRecordingsManager', 'actualEfSqlite', 'schemaHistoryPreserved']) assert.equal(native[flag], true, flag);
      assert.ok(native.collectionManagerInitialization.calls.includes('CollapseItemsWithinBoxSets'));
      assert.equal(native.imageProcessorInitialization.implementation, 'Jellyfin.Drawing.ImageProcessor');
      assert.ok(native.imageProcessorInitialization.calls.includes('GetImageCacheTag'));
      assert.equal(native.schemaCreated, false); assert.equal(native.recordingOrMediaExecution, false);
      assert.equal(native.userLookupControlled, false); assert.deepEqual(native.before, native.after);
      assert.equal(native.folderQueryInitialization.actualItemsArgumentInventory, true);
      assert.equal(native.folderQueryInitialization.actualPipeDelimitedBinder, true);
      assert.equal(native.folderQueryInitialization.httpHostExecuted, false);
      assert.deepEqual(Object.keys(native.before).sort(),
        [...nativeModel.tables.map(table => table.name), '__EFMigrationsHistory', '__EFMigrationsLock'].sort());
      assert.equal(native.preparation.foreignKeys.enabled, true); assert.deepEqual(native.preparation.foreignKeys.violations, []);
      assert.deepEqual(native.dtoInitialization.fields, input.dtoFields);
      assert.equal(native.dtoInitialization.EnableImages, false); assert.equal(native.dtoInitialization.EnableUserData, false);
      for (const result of native.results) {
        if (nullFailures.has(result.name) || formatFailures.has(result.name)) assert.equal(result.error?.status, 500);
        else assert.equal(result.error, null, result.name + ': native dependencies must execute successfully');
      }
      assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
      const byName = name => native.results.find(row => row.name === name);
      assert.equal(byName('cold persisted direct and linked children').value.TotalRecordCount, 2);
      assert.equal(byName('explicit empty handle retains only physical children').value.TotalRecordCount, 1);
      assert.equal(byName('relative Path precedes conflicting LibraryItemId').linksAfter[0].ItemId, id(20).replaceAll('-', ''));
      assert.equal(byName('warm parent Path controls relative fallback').linksAfter[0].ItemId, id(22).replaceAll('-', ''));
      assert.equal(byName('malformed LibraryItemId propagates without caching').linksAfter[0].ItemId, null);
      assert.deepEqual(byName('malformed identity preserves earlier cache publication').linksAfter.map(link => link.ItemId),
        [id(22).replaceAll('-', ''), null]);
      assert.equal(byName('missing valid LibraryItemId caches Empty').linksAfter[0].ItemId, '0'.repeat(32));
      assert.equal(byName('complete positive batch exceeds one page').value.TotalRecordCount, 141);
      const page = byName('SQL count and page follow resolved membership').value;
      assert.equal(page.TotalRecordCount, 141); assert.equal(page.StartIndex, 125); assert.equal(page.Items.length, 5);
      assert.equal(byName('name filter and paging use resolved membership').value.Items.length, 3);
      assert.equal(byName('single genre occurrence uses the native pipe binder').value.TotalRecordCount, 0);
      assert.equal(byName('single tag occurrence uses the native pipe binder').value.TotalRecordCount, 0);
      for (const [caseName, expected] of [
        ['single genre occurrence uses the native pipe binder', ['warm', 'genre']],
        ['warm typed genres retain literal separators', ['warm|genre', 'warm|genre']],
      ]) assert.deepEqual(native.folderQueryInitialization.bindings.find(row => row.caseName === caseName).bound, expected);
      assert.equal(byName('warm typed genres retain literal separators').value.TotalRecordCount, 1);
      assert.equal(byName('warm Children cross bounded pages before full SQL pagination').value.TotalRecordCount, 70);
      for (const assembly of native.assemblies) {
        await unchanged(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|MediaBrowser\.|Emby\.)/u.test(assembly.name)) captured.runtimeBindings.push({ name: assembly.name,
          ...await unchanged(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256) });
      }
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        assert.equal(library.loadedByExplicitResolver, true); await unchanged(library.filename, library.sha256);
        captured.runtimeBindings.push(await unchanged(path.join(current.runtimeRoot, 'runtimes', library.rid, 'native', path.basename(library.filename)), library.sha256));
      }
      await unchanged(native.databaseFilename, native.databaseSha256);
      for (const source of receipt.sourceFiles) await unchanged(source.filename, source.sha256);
      assert.deepEqual(await files(input.root), beforeNativeFiles);
      if (first) {
        assert.deepEqual(native.results.map(observedProjection), first.results.map(observedProjection));
        assert.deepEqual(native.before, first.before); assert.deepEqual(native.preparation, first.preparation);
        assert.equal(receipt.sourceFilesSha256, report.captures[0].receipt.sourceFilesSha256);
      }
      first ??= native; captured.inputsStable = true; await save();
    }
    report.independentNativeRepeatMatched = true;
    fixture = await openRootScenario(input, first, report);
    const before = await fixture.snapshot(); report.before = before;
    for (const [index, sample] of input.cases.entries()) {
      const actual = await fixture.run(sample), expected = first.results[index];
      compare(sample.name, observedProjection(actual), observedProjection(expected));
      report.cases.push({ name: sample.name, actual, native: expected }); await save();
    }
    report.after = await fixture.snapshot(); compare('all 31 persistent tables and files', report.after, before);
    const pages = report.queries.filter(row => /^SELECT \* FROM "mm_link_resolution_(raw|batch)_/u.test(row.text));
    assert.ok(pages.some(row => row.returned === 128)); assert.ok(pages.every(row => row.returned <= 128));
    const complete = pages.filter(row => row.case === 'complete positive batch exceeds one page');
    const rawStart = complete.findIndex(row => row.text.includes('mm_link_resolution_raw_'));
    assert.ok(rawStart > 0 && complete[rawStart - 1].text.includes('mm_link_resolution_batch_') && complete[rawStart - 1].returned === 0);
    assert.equal(complete.filter(row => row.text.includes('mm_link_resolution_batch_')).reduce((sum, row) => sum + row.returned, 0), 140);
    report.sqlBounds = { maximumReturned: Math.max(...pages.map(row => row.returned)), pageSize: 128,
      completePositiveBatchBeforeFallback: true, countAndPaginationInPostgres: true };
    // Count this ordered child projection separately from the live root path
    // relation read by visibility in the same request.
    const warmPages = report.queries.filter(row => row.case === 'warm Children cross bounded pages before full SQL pagination'
      && /^SELECT source\."Ordinal",source\."SlotKey" FROM \(SELECT cohort\."Ordinal",cohort\.slot_id AS "SlotKey",state\."Id"\s+FROM /u.test(row.text)
      && row.text.includes('item_cohorts'));
    assert.deepEqual(warmPages.map(row => row.returned), [128, 12, 0],
      'Every warm occurrence reaches the SQL projection in bounded pages before winner filtering and response paging.');
    report.sqlBounds.completeWarmProjectionBeforeFiltering = true;
    assert.deepEqual(fixture.errors, []);
    report.heldClose = await fixture.drain(input.cases.at(-1));
    compare('held folder query completes', report.heldClose.itemIds, first.results.at(-1).value.Items.map(item => item.Id).sort());
    const lock = report.pluginHostLease;
    assert.equal(lock.preShutdownIdentityUnchanged, true); assert.equal(lock.removedAfterRuntimeClose, true);
    compare('independent reopened PG and persistent files after shutdown', report.heldClose.afterShutdown,
      { database: before.database, files: Object.fromEntries(Object.entries(before.files).filter(([filename]) => filename !== lock.path)) });
    assert.deepEqual(fixture.errors, []); assert.deepEqual(report.differences, [], 'Every native Folder observation and candidate consumer must agree.');
    report.phaseAcceptance = true;
  } catch (error) { failure = error; }
  finally {
    const failures = [], attempt = async (name, action) => {
      try { await action(); report.cleanup[name] = true; }
      catch (error) { report.cleanup[name] = errorRecord(error); failures.push(error); }
    };
    await attempt('productionRuntimePostgresAndOwnersClosed', () => fixture?.close());
    await attempt('protectedNativeInputsUnchanged', () => current?.finish());
    if (sourceDatabase) await attempt('stoppedSourceDatabaseUnchanged', () => unchanged(sourceDatabase.filename, sourceDatabase.sha256));
    await attempt('neutralInputUnchanged', () => unchanged(inputFile, sha(inputBytes)));
    if (first) await attempt('controlledSeedUnchanged', () => unchanged(first.databaseFilename, first.databaseSha256));
    for (const source of report.sourceBindings ?? []) await attempt('source:' + path.basename(source.path), () => unchanged(source.path, source.sha256));
    await attempt('allPrivateDatabasesAndInstanceRemoved', () => removePrivateRoot(privateRoot, temporaryParent, 'mm-folder-links-'));
    if (failures.length) failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Folder links cleanup failed.');
    report.passed = !failure; if (failure) { report.phaseAcceptance = false; report.error = errorRecord(failure); } await save();
  }
  if (failure) throw failure;
});
