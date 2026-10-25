import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { idKey } from '../../src/library/records.js';
import { itemCollectionsInput, itemCollectionsId } from './fixtures/item-collections-current/input.js';
import { errorRecord, files, openScenario, prepareDirectories, removePrivateRoot, sha, wire } from './fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sourcePaths = [
  'Jellyfin.Api/Controllers/LibraryController.cs', 'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Emby.Server.Implementations/Collections/CollectionManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/UserDataManager.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
  'Emby.Server.Implementations/Localization/LocalizationManager.cs', 'Emby.Server.Implementations/Localization/Ratings/us.json',
  'Emby.Server.Implementations/Localization/iso6392.txt',
  'MediaBrowser.Model/Entities/ParentalRatingScore.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', 'MediaBrowser.Controller/Dto/DtoOptions.cs', 'MediaBrowser.Model/Querying/ItemFields.cs',
  'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs', 'Jellyfin.Server.Implementations/Item/ItemCountService.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/LinkedChildConfiguration.cs',
];
const expectedStatus = sample => sample.auth === 'anonymous' || sample.name === 'authorization apiKey' || /API key empty|unknown user/u.test(sample.name) ? 401
  : sample.name === 'ordinary cross user forbidden' ? 403
    : ['missing target', 'hidden target'].includes(sample.name) ? 404
      : sample.name === 'empty target' || /aggregate binding|binding before|invalid target|boundary binder \?startIndex=-/u.test(sample.name) ? 400 : 200;

test('current native item collections match real PostgreSQL HTTP manual parents, standalone visibility, OIC count/page, DTO and admitted SQL drain', {
  skip: !enabled, timeout: 1200000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'item-collections-current-' + randomUUID()); assertValidationOutputChild(output); await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const temporaryParent = await realpath(tmpdir()), privateRoot = await realpath(await mkdtemp(path.join(temporaryParent, 'mm-item-collections-')));
  const root = path.join(privateRoot, 'instance'), input = itemCollectionsInput(root), inputFile = path.join(output, 'input.json');
  const bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  const report = { schemaVersion: 1, inputSha256: sha(bytes), captures: [], cases: [], differences: [], cleanup: {},
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Actual designated MVC authorization/binding and actual EF SQLite repository/CollectionManager/DTO, independently repeated, compared to production PG runtime HTTP. Native principal creation is controlled; real native full-host authentication and media execution are outside this observation.',
    unmetPrerequisites: ['Complete product release and real production scale are not established by this read-only API differential.'] };
  let current, sourceDatabase, fixture, first, failure;
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
  const unchangedFile = async (filename, digest) => { const description = await describeFile(filename); assert.equal(description.available, true); assert.equal(description.sha256, digest, filename); return description; };
  const save = () => {
    let text = fixture ? fixture.safe(report) : JSON.stringify(report, null, 2);
    if (process.env.MEDIAMANAGER_TEST_POSTGRES) text = text.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]');
    return writeFile(path.join(output, 'report.json'), text + '\n');
  };
  const checkErrors = () => {
    for (const row of fixture?.errors ?? []) {
      const request = report.cases.find(value => value.name === row.case);
      const known = ['ordinary cross user forbidden', 'empty target'].includes(row.case);
      const allowed = known && request?.response.status === row.status && request?.native.status === row.status
        && row.status === expectedStatus(input.cases.find(value => value.name === row.case));
      assert.equal(allowed, true, 'An unknown request/background error must not be ignored: ' + fixture.safe(row));
      assert.deepEqual(wire(request.response), wire(request.native), 'The complete failure response must match its actual native request.');
      row.expectedRequestFailure = { method: 'GET', route: request.response.route, status: request.response.status,
        completeNativeWireMatched: true };
    }
  };
  try {
    await writeFile(inputFile, bytes);
    await prepareDirectories(root); const beforeNativeFiles = await files(root);
    current = await currentNativeReference(); report.preparation = current.preparation;
    sourceDatabase = await describeFile(current.sourceDatabase); report.sourceDatabase = sourceDatabase;
    report.sourceBindings = await current.sourceBindings(sourcePaths);
    for (const label of ['first', 'repeat']) {
      const receipt = await recordOracle({ project: 'tests/http/fixtures/item-collections-current/Oracle.csproj', output: path.join(output, label), environment: current.environment,
        args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native-' + label), current.sourceDatabase] });
      const filename = path.join(output, label, 'native.json'), nativeBytes = await readFile(filename), native = JSON.parse(nativeBytes);
      const captured = { label, receipt, output: await describeFile(filename), runtimeBindings: [] }; report.captures.push(captured);
      assert.equal(receipt.passed, true); assert.equal(receipt.build.status, 0); assert.equal(receipt.process.status, 0);
      assert.equal(native.inputSha256, sha(bytes)); assert.equal(native.sourceSha256, sourceDatabase.sha256);
      assert.equal(receipt.outputs.find(entry => entry.filename === filename).sha256, sha(nativeBytes));
      for (const flag of ['actualControllerAndMvc', 'actualRepositoryAndTypedMapper', 'actualLinkedChildrenService', 'actualCollectionManager', 'actualStandaloneVisibility',
        'actualDtoServiceAndUserData', 'actualEfSqlite', 'nativePrincipalControlled', 'schemaHistoryPreserved', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true, flag);
      assert.equal(native.schemaCreated, false); assert.equal(native.recordingOrMediaExecution, false); assert.equal(native.releaseAcceptance, false);
      assert.equal(native.ratingInitialization.loadedAll, true); assert.equal(native.ratingInitialization.countryCode, 'US');
      assert.ok(native.ratingInitialization.scores.G.score <= 5 && native.ratingInitialization.scores.R.score > 5);
      assert.equal(native.ratingInitialization.resources.length, 2);
      for (const resource of native.ratingInitialization.resources) {
        const bound = report.sourceBindings.find(source => source.path.replaceAll('\\', '/').endsWith('/' + resource.sourcePath));
        assert.ok(bound, resource.sourcePath); assert.equal(resource.sha256, bound.sha256);
        assert.equal(resource.bytes, (await describeFile(bound.path)).bytes);
      }
      assert.equal(native.preparation.cloneSha256, sourceDatabase.sha256);
      assert.equal(native.preparation.foreignKeys.enabled, true); assert.deepEqual(native.preparation.foreignKeys.violations, []);
      assert.ok(native.preparation.schema[0].length > 0 && native.preparation.schema[1].length > 0);
      assert.equal(sha(Buffer.from(native.preparation.schemaJson)), native.preparation.schemaSha256);
      assert.deepEqual(JSON.parse(native.preparation.schemaJson), native.preparation.schema);
      assert.deepEqual(native.before, native.after);
      assert.equal(native.manualParents.length, 270); assert.equal(new Set(native.manualParents.map(idKey)).size, 270);
      assert.ok(native.manualParents.every(value => ![itemCollectionsId(30), itemCollectionsId(31)].some(id => idKey(id) === idKey(value))));
      assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
      for (const [index, sample] of input.cases.entries()) assert.equal(native.results[index].status, expectedStatus(sample), sample.name + ': a native dependency error must not become a false baseline');
      const complete = native.results.find(row => row.name === 'all complete visible count');
      assert.equal(complete.json.TotalRecordCount, 270); assert.equal(complete.json.Items.length, 270);
      const limited = native.results.find(row => row.name === 'library complete visible count');
      assert.ok(limited.json.TotalRecordCount > 0 && limited.json.TotalRecordCount < 128);
      for (const mode of ['rating', 'tags', 'allowed']) {
        const result = native.results.find(row => row.name === mode + ' complete visible count');
        assert.ok(result.json.TotalRecordCount > 0 && result.json.TotalRecordCount < 270);
      }
      const favorite = complete.json.Items.find(item => idKey(item.Id) === idKey(itemCollectionsId(1000)));
      assert.equal(favorite.UserData.IsFavorite, true); assert.equal(favorite.UserData.PlayCount, 7);
      const tiedIds = new Set(Array.from({ length: 14 }, (_, index) => idKey(itemCollectionsId(1000 + index))));
      const tied = native.results.find(row => row.name === 'explicit forced sort Unicode name ties').json.Items.filter(item => tiedIds.has(idKey(item.Id)));
      assert.equal(tied.length, 14); assert.equal(new Set(tied.map(item => item.SortName)).size, 1);
      assert.ok(new Set(tied.map(item => item.Name)).size > 1, 'Actual cold typed mapper must preserve a shared forced SortName bucket with distinct Unicode Names.');
      assert.equal(native.results.find(row => row.name === 'parents complete visible count').json.TotalRecordCount, 0);
      const warm = native.results.find(row => row.name === 'live name and sort slot');
      assert.equal(idKey(warm.json.Items[0].Id), idKey(itemCollectionsId(1260)));
      assert.equal(warm.json.Items[0].Name, 'Warm retained collection 中文');
      const has = (name, number) => native.results.find(row => row.name === name).json.Items.some(item => idKey(item.Id) === idKey(itemCollectionsId(number)));
      assert.equal(has('all complete visible count', 1009), true);
      assert.equal(has('modern G collection bypasses R parent', 1009), true,
        'Modern BoxSet.IsVisibleStandalone delegates directly to IsVisible; it does not apply BaseItem parent checks.');
      assert.equal(has('cached nonfolder user-root membership', 1005), true,
        'Cached library identities compare every actual visible UserRoot child, including a Movie; there is no OfType<Folder> in this consumer.');
      assert.equal(has('warm cached library excludes collection', 1004), false);
      assert.equal(has('warm cached library empty bypass', 1004), true);
      assert.equal(has('warm official G to R', 1006), false);
      assert.equal(has('warm official R to G', 1007), true);
      assert.equal(has('warm custom R hides collection', 1008), false);
      assert.equal(has('warm custom G reveals collection', 1008), true);
      assert.equal(has('warm custom null uses official', 1008), true);
      assert.equal(native.results.find(row => row.name === 'user root target bypasses standalone visibility').json.TotalRecordCount, 0);
      for (const assembly of native.assemblies) {
        await unchangedFile(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|MediaBrowser\.|Emby\.)/u.test(assembly.name)) captured.runtimeBindings.push({ name: assembly.name,
          ...await unchangedFile(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256) });
      }
      for (const name of ['Jellyfin.Api', 'Jellyfin.Server.Implementations', 'Jellyfin.Database.Implementations', 'MediaBrowser.Controller', 'Emby.Server.Implementations'])
        assert.ok(captured.runtimeBindings.some(row => row.name === name), name);
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        assert.equal(library.loadedByExplicitResolver, true); await unchangedFile(library.filename, library.sha256);
        captured.runtimeBindings.push(await unchangedFile(path.join(current.runtimeRoot, 'runtimes', library.rid, 'native', path.basename(library.filename)), library.sha256));
      }
      await unchangedFile(native.databaseFilename, native.databaseSha256);
      assert.deepEqual(await files(root), beforeNativeFiles, 'Native reads must preserve every controlled input/state file.');
      for (const file of receipt.sourceFiles) await unchangedFile(file.filename, file.sha256);
      if (first) {
        assert.deepEqual(native.results.map(wire), first.results.map(wire), 'Independent current native captures must agree on complete wire values.');
        assert.deepEqual(native.before, first.before); assert.deepEqual(native.rootIds, first.rootIds); assert.deepEqual(native.manualParents, first.manualParents);
        assert.deepEqual(native.preparation, first.preparation);
        assert.equal(receipt.sourceFilesSha256, report.captures[0].receipt.sourceFilesSha256);
      }
      first ??= native; captured.inputsStable = true; await save();
    }
    report.independentNativeRepeatMatched = true;
    fixture = await openScenario(input, first.databaseFilename, report, first.rootIds);
    const before = await fixture.snapshot(); report.before = before;
    const lock = report.pluginHostLease;
    assert.equal(lock.path, 'plugins/node/host.lock');
    assert.deepEqual(before.files[lock.path], { bytes: lock.bytes, sha256: lock.sha256 });
    for (const [index, sample] of input.cases.entries()) {
      const response = await fixture.run(sample), expected = first.results[index];
      assert.equal(response.route, expected.route, 'Both backends must receive the actual same resolved request URI.');
      compare(sample.name + ': complete HTTP response', wire(response), wire(expected));
      report.cases.push({ name: sample.name, request: { path: sample.path, auth: sample.auth }, response, native: expected });
      await writeFile(path.join(output, 'progress.jsonl'), fixture.safe(report.cases.at(-1)) + '\n', { flag: 'a' });
    }
    const after = await fixture.snapshot(); report.after = after;
    compare('all persisted PG native tables and controlled files remain unchanged', after, before);
    checkErrors();
    const candidates = report.queries.filter(row => row.comment === 'item-collections-candidate-page');
    const resultPages = report.queries.filter(row => row.comment === 'item-collections-result-page');
    assert.ok(candidates.some(row => row.returned === 128)); assert.ok(resultPages.some(row => row.returned === 128));
    assert.ok(candidates.every(row => row.returned <= 128)); assert.ok(resultPages.every(row => row.returned <= 128));
    for (const mode of ['all', 'library', 'blocked', 'rating', 'tags', 'allowed', 'parents']) {
      const name = mode + ' complete visible count', pages = candidates.filter(row => row.case === name);
      assert.equal(pages.reduce((total, row) => total + row.returned, 0), 270, name + ': every manual candidate must be evaluated before count/page');
      const count = report.queries.find(row => row.case === name && row.comment === 'item-collections-count');
      assert.equal(count.count, first.results.find(row => row.name === name).json.TotalRecordCount);
    }
    report.sqlBounds = { candidates: candidates.length, resultPages: resultPages.length, pageSize: 128, completeVisibleCountBeforePage: true, hiddenCandidatesExceedOnePage: true };
    report.heldClose = await fixture.drain(input.cases.find(row => row.name === 'after warm admitted page'));
    compare('held admitted HTTP returns the same full page', wire(report.heldClose.response), wire(first.results.find(row => row.name === 'after warm admitted page')));
    assert.equal(report.heldClose.pluginHostLeaseRemoved, true); assert.equal(lock.preShutdownIdentityUnchanged, true);
    assert.equal(lock.removedAfterRuntimeClose, true); assert.equal(Object.hasOwn(report.heldClose.afterShutdown.files, lock.path), false);
    report.persistentStateComparison = { excludedTransientFiles: [lock.path],
      reason: 'This exact diagnostic plugin-host lock binds the actual PID/nonce/bytes and must be removed by its real owner at runtime close.' };
    const persistentBefore = { database: before.database,
      files: Object.fromEntries(Object.entries(before.files).filter(([filename]) => filename !== lock.path)) };
    compare('independent real PostgreSQL read after shutdown preserves rows and persistent files', report.heldClose.afterShutdown, persistentBefore);
    checkErrors();
    assert.deepEqual(report.differences, [], 'Every original native HTTP value and current PG consumer must agree.');
    report.phaseAcceptance = true;
  } catch (error) { failure = error; }
  finally {
    const failures = [], attempt = async (name, action) => { try { await action(); report.cleanup[name] = true; } catch (error) { report.cleanup[name] = errorRecord(error); failures.push(error); } };
    await attempt('nodeRuntimeAndPostgresClosed', () => fixture?.close());
    await attempt('onlyExactExpectedRequestDiagnostics', checkErrors);
    await attempt('protectedNativeInputsUnchanged', () => current?.finish());
    if (sourceDatabase) await attempt('stoppedSourceDatabaseUnchanged', () => unchangedFile(sourceDatabase.filename, sourceDatabase.sha256));
    await attempt('neutralInputUnchanged', () => unchangedFile(inputFile, sha(bytes)));
    if (first) await attempt('controlledNativeSeedUnchanged', () => unchangedFile(first.databaseFilename, first.databaseSha256));
    for (const row of report.sourceBindings ?? []) await attempt('source:' + path.basename(row.path), () => unchangedFile(row.path, row.sha256));
    await attempt('privateClonesAndInstanceRemoved', () => removePrivateRoot(privateRoot, temporaryParent, 'mm-item-collections-'));
    if (failures.length) failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Collections differential cleanup failed.');
    const visibilityQueries = (report.queryTimings ?? []).filter(row => row.visibilityItems !== undefined);
    report.visibilityBatches = { diagnosticOnly: true, queries: visibilityQueries.length,
      singletonQueries: visibilityQueries.filter(row => row.visibilityItems === 1).length,
      batchedQueries: visibilityQueries.filter(row => row.visibilityItems > 1).length,
      maxItems: visibilityQueries.reduce((maximum, row) => Math.max(maximum, row.visibilityItems), 0) };
    report.passed = !failure; if (failure) { report.phaseAcceptance = false; report.error = errorRecord(failure); }
    await save();
  }
  if (failure) throw failure;
});
