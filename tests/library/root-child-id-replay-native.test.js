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
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { rootChildIdInput } from './fixtures/user-root-linked-current/child-id-input.js';
import { rootLinkId as id } from './fixtures/user-root-linked-current/input.js';
import { errorRecord, files, observedProjection, openRootScenario, sha } from './fixtures/user-root-linked-current/scenario.js';
import { prepareDirectories, removePrivateRoot } from '../http/fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sourcePaths = [
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs', 'MediaBrowser.Controller/Entities/AggregateFolder.cs',
  'MediaBrowser.Controller/Entities/LinkedChild.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Dto/DtoOptions.cs', 'MediaBrowser.Controller/Library/LibraryManagerExtensions.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/UserViewManager.cs',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/Localization/LocalizationManager.cs',
  'Emby.Server.Implementations/Localization/Ratings/us.json', 'Emby.Server.Implementations/Localization/iso6392.txt',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs', 'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs',
];

test('current native UserRoot child-ID replay returns manager aliases, original order and complete DTO values in PostgreSQL', {
  skip: !enabled, timeout: 720000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'root-child-id-replay-' + randomUUID()); assertValidationOutputChild(output);
  await mkdir(output, { recursive: true });
  const parent = await realpath(tmpdir()), privateRoot = await realpath(await mkdtemp(path.join(parent, 'mm-root-ids-')));
  const input = rootChildIdInput(path.join(privateRoot, 'instance')), inputFile = path.join(output, 'input.json');
  const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), captures: [], cases: [], differences: [], cleanup: {},
    phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Separate neutral input over actual UserRoot.Children/GetChildren, LibraryManager.GetCollectionFolders and DtoService, independently repeated; formal PostgreSQL runtime navigation and queryItems. No complete private Children graph, GC recovery or final release acceptance.' };
  let current, sourceDatabase, first, fixture, failed = false, failure;
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
    report.neutralInputSources = await Promise.all(['child-id-input.js', 'input.js'].map(filename =>
      describeFile(path.resolve('tests/library/fixtures/user-root-linked-current', filename))));
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
      for (const flag of ['actualRepositoryAndTypedMapper', 'actualLinkedChildrenService', 'actualRootGetChildren',
        'actualCollectionFolders', 'actualDtoService', 'actualEfSqlite', 'schemaHistoryPreserved']) assert.equal(native[flag], true, flag);
      assert.equal(native.schemaCreated, false); assert.equal(native.recordingOrMediaExecution, false);
      assert.equal(native.preparation.cloneSha256, sourceDatabase.sha256);
      assert.equal(native.preparation.foreignKeys.enabled, true); assert.deepEqual(native.preparation.foreignKeys.violations, []);
      assert.deepEqual(native.before, native.after); assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
      for (const result of native.results) assert.equal(result.error, null, result.name);
      const byName = name => native.results.find(row => row.name === name).value;
      const original = byName(input.cases[0].name), held = byName(input.cases[1].name), replayed = byName(input.cases[2].name);
      assert.deepEqual(held, original, 'Changing manager values cannot replace populated Children.');
      assert.deepEqual(replayed.map(item => item.id), original.map(item => item.id));
      assert.equal(replayed[0].name, 'Zulu manager first'); assert.equal(replayed[0].parentId, id(14).replaceAll('-', ''));
      assert.equal(byName(input.cases[3].name)[0].name, 'Zulu manager first');
      assert.deepEqual(byName(input.cases[4].name).map(item => item.name), ['Private warm first']);
      assert.deepEqual(byName(input.cases[5].name).map(item => item.name), ['Zulu manager first', 'Alpha manager second', 'Stored direct movie']);
      assert.deepEqual(byName(input.cases[6].name).map(item => item.Name), ['Zulu manager first', 'Alpha manager second', 'Stored direct movie']);
      for (const assembly of native.assemblies) {
        await unchanged(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|MediaBrowser\.|Emby\.)/u.test(assembly.name)) captured.runtimeBindings.push(await unchanged(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256));
      }
      for (const library of native.nativeLibraries) {
        await unchanged(library.filename, library.sha256);
        captured.runtimeBindings.push(await unchanged(path.join(current.runtimeRoot, 'runtimes', library.rid, 'native', path.basename(library.filename)), library.sha256));
      }
      await unchanged(native.databaseFilename, native.databaseSha256); assert.deepEqual(await files(input.root), beforeNativeFiles);
      for (const file of receipt.sourceFiles) await unchanged(file.filename, file.sha256);
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
    const after = await fixture.snapshot(); report.after = after; compare('complete persisted rows/files', after, before);
    report.heldClose = await fixture.drain();
    report.afterShutdown = report.heldClose.afterShutdown;
    const lock = report.pluginHostLease;
    compare('PG and persistent files after runtime close', report.afterShutdown, { database: before.database,
      files: Object.fromEntries(Object.entries(before.files).filter(([filename]) => filename !== lock.path)) });
    assert.deepEqual(report.differences, []); report.phaseAcceptance = true;
  } catch (error) { failed = true; failure = error; }
  finally {
    const failures = [], attempt = async (name, action) => {
      try { await action(); report.cleanup[name] = true; }
      catch (error) { report.cleanup[name] = errorRecord(error); failures.push(error); }
    };
    await attempt('productionRuntimePostgresAndOwnersClosed', () => fixture?.close());
    await attempt('protectedNativeInputsUnchanged', () => current?.finish());
    if (sourceDatabase) await attempt('stoppedSourceDatabaseUnchanged', () => unchanged(sourceDatabase.filename, sourceDatabase.sha256));
    await attempt('neutralInputUnchanged', () => unchanged(inputFile, sha(inputBytes)));
    for (const source of report.neutralInputSources ?? []) await attempt('inputSource:' + path.basename(source.filename), () => unchanged(source.filename, source.sha256));
    if (first) await attempt('controlledSeedUnchanged', () => unchanged(first.databaseFilename, first.databaseSha256));
    for (const source of report.sourceBindings ?? []) await attempt('source:' + path.basename(source.path), () => unchanged(source.path, source.sha256));
    await attempt('allPrivateDatabasesAndInstanceRemoved', () => removePrivateRoot(privateRoot, parent, 'mm-root-ids-'));
    if (failures.length) {
      failure = new AggregateError([...(failed ? [failure] : []), ...failures], 'Root child-ID cleanup failed.', { cause: failed ? failure : failures[0] });
      failed = true;
    }
    t.diagnostic(inspect({ runtimeErrors: fixture?.errors }, { depth: null, maxArrayLength: null }));
    report.passed = !failed;
    if (failed) { report.phaseAcceptance = false; report.error = errorRecord(failure); }
    await save();
  }
  if (failed) throw failure;
});
