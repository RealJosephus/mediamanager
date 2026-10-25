import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { rootLinkInput, rootLinkId } from './fixtures/user-root-linked-current/input.js';
import { errorRecord, files, observedProjection, openRootScenario, sha } from './fixtures/user-root-linked-current/scenario.js';
import { prepareDirectories, removePrivateRoot } from '../http/fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sourcePaths = [
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs', 'MediaBrowser.Controller/Entities/AggregateFolder.cs',
  'MediaBrowser.Controller/Entities/LinkedChild.cs', 'MediaBrowser.Controller/Entities/Movies/BoxSet.cs',
  'MediaBrowser.Controller/Library/LibraryManagerExtensions.cs',
  'MediaBrowser.Controller/Entities/Audio/MusicArtist.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
  'Emby.Server.Implementations/Localization/LocalizationManager.cs', 'Emby.Server.Implementations/Localization/Ratings/us.json',
  'Emby.Server.Implementations/Localization/iso6392.txt',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/ServerApplicationPaths.cs',
  'MediaBrowser.Controller/Dto/DtoOptions.cs', 'MediaBrowser.Controller/Entities/Genre.cs',
  'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Model/Dto/BaseItemDto.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
  'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs',
  'MediaBrowser.Model/Entities/ParentalRatingScore.cs',
  'Emby.Server.Implementations/Library/Resolvers/GenericFolderResolver.cs',
  'Emby.Server.Implementations/Library/UserViewManager.cs', 'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'Emby.Server.Implementations/Collections/CollectionManager.cs', 'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
];

test('current native UserRoot links preserve positive batches, warm occurrences, raw folders, BoxSet membership and typed menu consumers in production PostgreSQL', {
  skip: !enabled, timeout: 720000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'user-root-linked-current-' + randomUUID()); assertValidationOutputChild(output);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const temporaryParent = await realpath(tmpdir()), privateRoot = await realpath(await mkdtemp(path.join(temporaryParent, 'mm-root-links-')));
  const input = rootLinkInput(path.join(privateRoot, 'instance')), inputFile = path.join(output, 'input.json');
  const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), captures: [], cases: [], differences: [], cleanup: {},
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Actual designated repository/mapper/UserRoot.GetChildren and complete DtoService plain-root output, raw GetCollectionFolders, CollectionManager and UserViewManager, independently repeated; production PG transferred rows, loadNavigation, formal queryItems and public item-collections consumers. Controlled warm inputs; no media execution or native full-host HTTP/auth claim.',
    unmetPrerequisites: ['No full library topology, complete HTTP DTO/error-wire or final release acceptance is established by this component slice.'] };
  let current, sourceDatabase, first, fixture, failure;
  const unchanged = async (filename, expected) => { const value = await describeFile(filename); assert.equal(value.available, true); assert.equal(value.sha256, expected, filename); return value; };
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
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
      const receipt = await recordOracle({ project: 'tests/library/fixtures/user-root-linked-current/Oracle.csproj', output: path.join(output, label), environment: current.environment,
        args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native-' + label), current.sourceDatabase] });
      const nativeFilename = path.join(output, label, 'native.json'), nativeBytes = await readFile(nativeFilename), native = JSON.parse(nativeBytes);
      const captured = { label, receipt, output: await describeFile(nativeFilename), runtimeBindings: [] }; report.captures.push(captured);
      assert.equal(receipt.passed, true); assert.equal(receipt.build.status, 0); assert.equal(receipt.process.status, 0);
      assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.sourceSha256, sourceDatabase.sha256);
      assert.equal(receipt.outputs.find(row => row.filename === nativeFilename).sha256, sha(nativeBytes));
      for (const flag of ['actualRepositoryAndTypedMapper', 'actualLinkedChildrenService', 'actualRootGetChildren', 'actualCollectionManager', 'actualCollectionFolders', 'actualUserViewManager', 'actualDtoService', 'actualReadOnlyRecordingsManager', 'actualEfSqlite', 'schemaHistoryPreserved']) assert.equal(native[flag], true, flag);
      assert.equal(native.schemaCreated, false); assert.equal(native.recordingOrMediaExecution, false); assert.equal(native.userLookupControlled, false);
      assert.equal(native.ratingInitialization.loadedAll, true); assert.equal(native.ratingInitialization.countryCode, 'US');
      assert.ok(native.ratingInitialization.scores.G.score <= 5 && native.ratingInitialization.scores.R.score > 5);
      assert.equal(native.ratingInitialization.resources.length, 2);
      assert.deepEqual(native.dtoInitialization.fields, input.dtoFields);
      assert.equal(native.dtoInitialization.EnableImages, false); assert.equal(native.dtoInitialization.EnableUserData, false);
      for (const flag of ['skipVisibilityCheck', 'activeRecordingsBeforeAndAfterEmpty', 'mediaExecutionDependenciesAbsent']) assert.equal(native.dtoInitialization[flag], true);
      for (const resource of native.ratingInitialization.resources) {
        const bound = report.sourceBindings.find(source => source.path.replaceAll('\\', '/').endsWith('/' + resource.sourcePath));
        assert.ok(bound, resource.sourcePath); assert.equal(resource.sha256, bound.sha256);
        assert.equal(resource.bytes, (await describeFile(bound.path)).bytes);
      }
      assert.equal(native.preparation.cloneSha256, sourceDatabase.sha256); assert.equal(native.preparation.foreignKeys.enabled, true);
      assert.deepEqual(native.preparation.foreignKeys.violations, []); assert.deepEqual(native.before, native.after);
      const schema = JSON.parse(native.preparation.schemaJson);
      assert.equal(schema.length, 2); assert.ok(schema[0].length > 0 && schema[1].length > 0);
      assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
      for (const result of native.results) {
        if (result.name === 'typed null is consumed as native failure' || result.name.startsWith('malformed LibraryItemId')) assert.equal(result.error?.status, 500);
        else assert.equal(result.error, null, result.name + ': dependency failures must not become a false positive baseline');
      }
      const byName = name => native.results.find(row => row.name === name);
      assert.equal(byName('cold full root all').value.length, 143); assert.ok(byName('cold full root rating').value.length > 128);
      assert.deepEqual(byName('cold menu omits Movie links').value.map(row => row.id).sort(), [10, 11].map(number => rootLinkId(number).replaceAll('-', '')));
      assert.deepEqual(byName('raw collection folders before warm').value.map(row => row.id), [rootLinkId(10).replaceAll('-', '')]);
      assert.equal(byName('explicit empty root handle clears persisted links').value.length, 3);
      const duplicate = byName('direct virtual linked same Guid keeps first slot and last positive object').value;
      assert.deepEqual(duplicate.map(row => row.id), [19, 14, 20].map(number => rootLinkId(number).replaceAll('-', '')));
      assert.equal(duplicate[0].name, 'Stored direct movie'); assert.equal(duplicate[2].name, 'Linked movie 000');
      assert.equal(byName('raw folders consume exact warm Children only').value.length, 0);
      assert.deepEqual(byName('cached linked identity grants BoxSet membership').value, [600, 601].map(number => rootLinkId(number).replaceAll('-', '')));
      assert.deepEqual(byName('cleared linked membership hides only linked BoxSet').value, [rootLinkId(601).replaceAll('-', '')]);
      assert.equal(byName('relative Path fallback wins conflicting LibraryItemId').linksAfter[0].ItemId, rootLinkId(500).replaceAll('-', ''));
      assert.equal(byName('Guid.Empty never retries a valid Path').linksAfter[0].ItemId, '0'.repeat(32));
      assert.equal(byName('missing target caches Guid.Empty').linksAfter[0].ItemId, '0'.repeat(32));
      assert.equal(byName('malformed LibraryItemId fails without caching').linksAfter[0].ItemId, null);
      assert.deepEqual(byName('malformed LibraryItemId keeps an earlier successful cache').linksAfter.map(link => link.ItemId),
        [rootLinkId(21).replaceAll('-', ''), null]);
      const menuArtist = byName('actual menu retains typed by-name MusicArtist').value.find(row => row.id === rootLinkId(400).replaceAll('-', ''));
      assert.equal(menuArtist.isFolder, false); assert.equal(menuArtist.isTypedFolder, true);
      assert.ok(byName('root IsVisible allows own G through R parent').value.some(row => row.id === rootLinkId(500).replaceAll('-', '')));
      const dtos = name => byName(name).value;
      assert.equal(dtos('plain root complete DTO uses all 140 positive links').length, 143);
      const independent = dtos('plain root DTO retains independent unsaved direct and virtual media');
      assert.deepEqual(independent.map(row => row.Id), [19, 500].map(number => rootLinkId(number).replaceAll('-', '')));
      for (const [index, prefix] of ['Direct unsaved', 'Virtual unsaved'].entries()) {
        const dto = independent[index];
        assert.equal(dto.Name, prefix + ' name'); assert.equal(dto.Overview, prefix + ' overview');
        assert.deepEqual(dto.Genres, [prefix + ' genre', '']); assert.deepEqual(dto.Tags, [prefix + ' tag', '']);
        assert.deepEqual(dto.Taglines, [prefix + ' tagline']); assert.deepEqual(dto.ProviderIds, { Tmdb: prefix + '-tmdb', Imdb: prefix + '-imdb' });
        assert.equal(dto.GenreItems.length, 1); assert.equal(dto.GenreItems[0].Name, prefix + ' genre');
      }
      const lastVirtual = dtos('plain root DTO keeps first Guid position and last unsaved virtual value');
      assert.deepEqual(lastVirtual.map(row => row.Id), [19, 500].map(number => rootLinkId(number).replaceAll('-', '')));
      assert.equal(lastVirtual[0].Name, 'Last virtual name'); assert.equal(Object.hasOwn(lastVirtual[0], 'Overview'), false);
      assert.deepEqual(lastVirtual[0].Taglines, []); assert.deepEqual(lastVirtual[0].Genres, ['Last virtual genre', '']);
      const replaced = dtos('plain root positive repository DTO replaces same Guid unsaved occurrences');
      assert.deepEqual(replaced.map(row => row.Id), [19, 20].map(number => rootLinkId(number).replaceAll('-', '')));
      assert.deepEqual(replaced.map(row => row.Name), ['Stored direct movie', 'Linked movie 000']);
      for (const dto of replaced) { assert.deepEqual(dto.Genres, []); assert.deepEqual(dto.ProviderIds, {}); assert.deepEqual(dto.Taglines, []); }
      assert.deepEqual(dtos('plain root positive DTO ignores complete registered warm metadata').map(row => row.Name), ['Linked movie 000', 'Linked movie 001']);
      for (const assembly of native.assemblies) {
        await unchanged(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|MediaBrowser\.|Emby\.)/u.test(assembly.name)) captured.runtimeBindings.push({ name: assembly.name,
          ...await unchanged(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256) });
      }
      for (const name of ['MediaBrowser.Controller', 'Emby.Server.Implementations', 'Jellyfin.Server.Implementations', 'Jellyfin.Database.Implementations', 'Jellyfin.LiveTv']) assert.ok(captured.runtimeBindings.some(row => row.name === name));
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        assert.equal(library.loadedByExplicitResolver, true); await unchanged(library.filename, library.sha256);
        captured.runtimeBindings.push(await unchanged(path.join(current.runtimeRoot, 'runtimes', library.rid, 'native', path.basename(library.filename)), library.sha256));
      }
      await unchanged(native.databaseFilename, native.databaseSha256); assert.deepEqual(await files(input.root), beforeNativeFiles);
      for (const file of receipt.sourceFiles) await unchanged(file.filename, file.sha256);
      if (first) {
        assert.deepEqual(native.results.map(observedProjection), first.results.map(observedProjection)); assert.deepEqual(native.before, first.before);
        assert.deepEqual(native.preparation, first.preparation); assert.deepEqual(native.rootIds, first.rootIds);
        assert.equal(receipt.sourceFilesSha256, report.captures[0].receipt.sourceFilesSha256);
      }
      first ??= native; captured.inputsStable = true; await save();
    }
    report.independentNativeRepeatMatched = true;
    report.dtoComparison = { fields: input.dtoFields, nativeConsumer: 'DtoService.GetBaseItemDtos(UserRoot.GetChildren(user,true), skipVisibilityCheck:true)',
      nodeConsumer: 'LibraryService.queryItems plain UserRoot', completeSerializedDtos: true,
      caseNames: input.cases.filter(sample => sample.lane === 'dto').map(sample => sample.name) };
    fixture = await openRootScenario(input, first, report); const before = await fixture.snapshot(); report.before = before;
    const lock = report.pluginHostLease;
    assert.equal(lock.path, 'plugins/node/host.lock');
    assert.deepEqual(before.files[lock.path], { bytes: lock.bytes, sha256: lock.sha256 });
    for (const [index, sample] of input.cases.entries()) {
      const actual = await fixture.run(sample), expected = first.results[index];
      compare(sample.name, observedProjection(actual), observedProjection(expected));
      report.cases.push({ name: sample.name, actual, native: expected }); await save();
    }
    const after = await fixture.snapshot(); report.after = after; compare('complete persisted rows/files', after, before);
    const pages = report.queries.filter(row => /^SELECT \* FROM "mm_link_resolution_(raw|batch)_/u.test(row.text));
    assert.ok(pages.some(row => row.returned === 128)); assert.ok(pages.every(row => row.returned <= 128));
    const firstPages = pages.filter(row => row.case === 'cold full root all');
    const batchPages = firstPages.filter(row => row.text.includes('mm_link_resolution_batch_'));
    assert.equal(batchPages.reduce((sum, row) => sum + row.returned, 0), 140);
    const firstRaw = firstPages.findIndex(row => row.text.includes('mm_link_resolution_raw_'));
    assert.ok(firstRaw > 0 && firstPages[firstRaw - 1].text.includes('mm_link_resolution_batch_') && firstPages[firstRaw - 1].returned === 0,
      'The complete successful positive batch must finish before the raw fallback walk begins.');
    report.sqlBounds = { resolutionPages: pages.length, maximumReturned: Math.max(...pages.map(row => row.returned)), pageSize: 128,
      coldRootVisibleCount: first.results[0].value.length, completeSuccessfulPositiveBatchBeforeRawWalk: true };
    assert.deepEqual(fixture.errors, []);
    report.heldClose = await fixture.drain();
    compare('held public membership result', report.heldClose.itemIds, first.results.find(row => row.name === 'linked cached membership returns after replacement').value);
    assert.equal(report.heldClose.pluginHostLeaseRemoved, true); assert.equal(lock.preShutdownIdentityUnchanged, true);
    assert.equal(lock.removedAfterRuntimeClose, true); assert.equal(Object.hasOwn(report.heldClose.afterShutdown.files, lock.path), false);
    report.persistentStateComparison = { excludedTransientFiles: [lock.path],
      reason: 'This exact diagnostic plugin-host lock binds the actual PID/nonce/bytes and must be removed by its real owner at runtime close.' };
    const persistentBefore = { database: before.database,
      files: Object.fromEntries(Object.entries(before.files).filter(([filename]) => filename !== lock.path)) };
    compare('independent PG and persistent files after shutdown', report.heldClose.afterShutdown, persistentBefore); assert.deepEqual(fixture.errors, []);
    assert.deepEqual(report.differences, [], 'Every native root/menu/raw/BoxSet observation and PG consumer must agree.'); report.phaseAcceptance = true;
  } catch (error) { failure = error; }
  finally {
    const failures = [], attempt = async (name, action) => { try { await action(); report.cleanup[name] = true; } catch (error) { report.cleanup[name] = errorRecord(error); failures.push(error); } };
    await attempt('productionRuntimePostgresAndOwnersClosed', () => fixture?.close());
    await attempt('protectedNativeInputsUnchanged', () => current?.finish());
    if (sourceDatabase) await attempt('stoppedSourceDatabaseUnchanged', () => unchanged(sourceDatabase.filename, sourceDatabase.sha256));
    await attempt('neutralInputUnchanged', () => unchanged(inputFile, sha(inputBytes)));
    if (first) await attempt('controlledSeedUnchanged', () => unchanged(first.databaseFilename, first.databaseSha256));
    for (const source of report.sourceBindings ?? []) await attempt('source:' + path.basename(source.path), () => unchanged(source.path, source.sha256));
    await attempt('allPrivateDatabasesAndInstanceRemoved', () => removePrivateRoot(privateRoot, temporaryParent, 'mm-root-links-'));
    if (failures.length) failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Root links cleanup failed.');
    report.passed = !failure; if (failure) { report.phaseAcceptance = false; report.error = errorRecord(failure); } await save();
  }
  if (failure) throw failure;
});
