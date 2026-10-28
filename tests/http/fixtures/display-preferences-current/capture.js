import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../../../tools/compat/current-native-reference.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { compileOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';
import { projectPreferenceObservation } from '../display-preferences/observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
export const currentPreferenceInputsAvailable = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE);
const inputFilename = fileURLToPath(new URL('./input.json', import.meta.url));
const project = 'tests/http/fixtures/display-preferences-current/Oracle.csproj';
const sourcePaths = [
  'Jellyfin.Api/Controllers/DisplayPreferencesController.cs',
  'Jellyfin.Server.Implementations/Users/DisplayPreferencesManager.cs',
  'MediaBrowser.Model/Dto/DisplayPreferencesDto.cs', 'MediaBrowser.Controller/IDisplayPreferencesManager.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs', 'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs', 'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/DisplayPreferences.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemDisplayPreferences.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/CustomItemDisplayPreferences.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/HomeSection.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/IndexingKind.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/HomeSectionType.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/ScrollDirection.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/ChromecastVersion.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/ViewType.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/SortOrder.cs',
];
let currentPromise;
const captures = new Map();

async function sameFile(filename, expected) {
  const actual = await describeFile(filename);
  assert.equal(actual.available, true, `Required captured input is missing: ${filename}`);
  assert.equal(actual.sha256, expected, `Captured input changed: ${filename}`);
  return actual;
}

async function removePrivateDatabases(output, label) {
  assert.ok(label === 'first' || label === 'repeat');
  const owner = path.resolve(output), captureRoot = path.resolve(owner, label), states = path.resolve(captureRoot, 'states');
  assert.equal(path.dirname(captureRoot), owner); assert.equal(path.basename(captureRoot), label);
  assert.equal(path.dirname(states), captureRoot); assert.equal(path.basename(states), 'states');
  assertValidationOutputChild(states);
  assert.equal(path.relative(owner, await realpath(owner)), '', 'The capture root must not traverse links.');
  async function inspect(filename) {
    const info = await lstat(filename);
    assert.equal(info.isSymbolicLink(), false, 'Private database cleanup must not follow links.');
    assert.equal(path.relative(filename, await realpath(filename)), '', 'Private database paths must resolve to themselves.');
    if (info.isDirectory()) for (const entry of await readdir(filename)) await inspect(path.join(filename, entry));
    else assert.equal(info.isFile(), true, 'Unexpected private database filesystem entry.');
  }
  let parent;
  try { parent = await lstat(captureRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.equal(parent.isSymbolicLink(), false); assert.equal(parent.isDirectory(), true);
  assert.equal(path.relative(captureRoot, await realpath(captureRoot)), '');
  try { await lstat(states); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await inspect(states);
  // All started synchronous recorder processes have returned (including timeout
  // or failure) before finally reaches this path. Deleted SQLite pages may retain
  // original seed bytes, so these private files must never become artifacts.
  await rm(states, { recursive: true });
  await assert.rejects(lstat(states), { code: 'ENOENT' });
}

async function capture(mode) {
  const output = path.join(validationOutputRoot(), `display-preferences-current-${mode}-${randomUUID()}`);
  assertValidationOutputChild(output);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const report = { schemaVersion: 1, mode, captures: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false,
    historicalRecordingReused: false, scope: mode === 'http'
      ? 'Current designated MVC, actual authorization/binding/controller/manager/EF SQLite, 119 scenarios and 126 requests, independently repeated; PG compares complete HTTP and preference rows.'
      : 'Current designated controller/EF display-home snapshot at item lookup, independently repeated; production PG runtime HTTP compares that phase and the later committed read.',
    unmetPrerequisites: ['Full product release, production scale and complete native instance migration are outside this component observation.'] };
  let current, sourceDatabase, sourceBindings, input, first, failure;
  try {
    current = await (currentPromise ??= currentNativeReference());
    report.preparation = current.preparation;
    sourceDatabase = await describeFile(current.sourceDatabase);
    assert.equal(sourceDatabase.available, true);
    sourceBindings = await current.sourceBindings(sourcePaths);
    input = await describeFile(inputFilename);
    report.inputs = { input, sourceDatabase, sourceBindings };
    const samples = JSON.parse(await readFile(inputFilename, 'utf8'));
    assert.equal(samples.length, 119);
    assert.equal(samples.reduce((count, sample) => count + (sample.steps?.length ?? 1), 0), 126);
    const oracle = await compileOracle({ project, output: path.join(output, 'build'), environment: current.environment });
    report.oracleBuild = oracle.buildRecord;
    for (const label of ['first', 'repeat']) {
      const receipt = await oracle.record({ output: path.join(output, label),
        args: [mode, inputFilename, '{output}/native.json', current.sourceDatabase] });
      const nativeFilename = path.join(output, label, 'native.json');
      const nativeBytes = await readFile(nativeFilename), native = JSON.parse(nativeBytes);
      const captured = { label, receipt, native: await describeFile(nativeFilename), runtimeBindings: [] };
      report.captures.push(captured);
      assert.equal(receipt.passed, true);
      assert.equal(receipt.build.status, 0); assert.equal(receipt.process.status, 0);
      assert.equal(native.mode, mode); assert.equal(native.inputSha256, input.sha256);
      assert.equal(native.sourceDatabaseSha256, sourceDatabase.sha256);
      for (const flag of ['actualController', 'actualManager', 'actualEfSqlite', 'principalControlled']) assert.equal(native[flag], true, flag);
      assert.equal(native.actualBinding, mode === 'http');
      assert.equal(native.historicalRecordingReused, false); assert.equal(native.actualNativeServerStarted, false);
      assert.equal(native.prohibitedMediaExecution, false);
      assert.equal(native.databasePreparations.length, mode === 'http' ? samples.length : 1);
      for (const preparation of native.databasePreparations) {
        assert.equal(preparation.sourceSha256, sourceDatabase.sha256); assert.equal(preparation.cloneSha256, sourceDatabase.sha256);
        assert.equal(preparation.schemaPreserved, true); assert.equal(preparation.historyPreserved, true);
        assert.ok(preparation.migrationCount > 0); assert.equal(preparation.ensureCreatedUsed, false);
        assert.equal(preparation.managerForeignKeysEnabled, true); assert.equal(preparation.resetIntegerIdentities, true);
        for (const table of ['DisplayPreferences', 'ItemDisplayPreferences', 'CustomItemDisplayPreferences', 'HomeSection', 'Users']) assert.ok(preparation.clearedTables.includes(table));
        assert.equal(preparation.schemaSha256, native.databasePreparations[0].schemaSha256);
        assert.equal(preparation.historySha256, native.databasePreparations[0].historySha256);
      }
      for (const assembly of native.assemblies) {
        await sameFile(assembly.filename, assembly.sha256);
        if (/^(?:Jellyfin\.|MediaBrowser\.|Emby\.)/u.test(assembly.name)) {
          const bound = await sameFile(path.join(current.runtimeRoot, path.basename(assembly.filename)), assembly.sha256);
          captured.runtimeBindings.push({ name: assembly.name, ...bound });
        }
      }
      for (const name of ['Jellyfin.Api', 'Jellyfin.Server.Implementations', 'Jellyfin.Database.Implementations', 'MediaBrowser.Model']) assert.ok(captured.runtimeBindings.some(row => row.name === name), name);
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        assert.equal(library.loadedByExplicitResolver, true); await sameFile(library.filename, library.sha256);
        const name = path.basename(library.filename);
        const supplied = receipt.sourceFiles.find(row => row.filename.endsWith('/Oracle.csproj') || row.filename.endsWith('\\Oracle.csproj'));
        assert.ok(supplied, 'The current recorder project must be bound.');
        // The project's mandatory current RID Content item binds the actual
        // copied library. Record that immutable supplied path independently.
        assert.match(native.runtimeIdentifier, /^(?:win|linux|osx)-(?:x64|arm64)$/u);
        captured.runtimeBindings.push(await sameFile(path.join(current.runtimeRoot, 'runtimes', native.runtimeIdentifier, 'native', name), library.sha256));
      }
      if (mode === 'http') {
        assert.equal(native.observation.hostStopped, true); assert.equal(native.observation.hostDisposed, true);
        assert.deepEqual(native.observation.results.map(row => row.name), samples.map(row => row.name));
        assert.equal(native.observation.results.reduce((count, row) => count + row.observations.length, 0), 126);
        if (first) assert.deepEqual(native.observation.results.map(projectPreferenceObservation), first.observation.results.map(projectPreferenceObservation));
      } else {
        assert.equal(native.observation.mutationBeforeItemLookup, true);
        assert.deepEqual(native.observation.actual, { ShowBackdrop: true, home: 'resume' });
        assert.deepEqual(native.observation.current, { ShowBackdrop: false, home: 'latestmedia' });
        if (first) assert.deepEqual(native.observation, first.observation);
      }
      if (first) {
        assert.equal(receipt.sourceFilesSha256, report.captures[0].receipt.sourceFilesSha256);
        assert.deepEqual(native.databasePreparations.map(({ schemaSha256, historySha256 }) => ({ schemaSha256, historySha256 })),
          first.databasePreparations.map(({ schemaSha256, historySha256 }) => ({ schemaSha256, historySha256 })));
      }
      first ??= native;
      for (const source of receipt.sourceFiles) await sameFile(source.filename, source.sha256);
      await sameFile(inputFilename, input.sha256); await sameFile(current.sourceDatabase, sourceDatabase.sha256);
      for (const source of sourceBindings) await sameFile(source.path, source.sha256);
      captured.inputsStable = true;
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    report.independentRepeatMatched = true; report.phaseAcceptance = true;
  } catch (error) {
    failure = error; report.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    const failures = [];
    const verify = async (name, operation) => { try { await operation(); report.cleanup[name] = true; } catch (error) { failures.push(error); report.cleanup[name] = { name: error.name, message: error.message }; } };
    for (const label of ['first', 'repeat']) await verify(`${label}PrivateDatabasesRemoved`, () => removePrivateDatabases(output, label));
    if (current) await verify('protectedInputsUnchanged', () => current.finish());
    if (sourceDatabase) await verify('sourceDatabaseUnchanged', () => sameFile(sourceDatabase.filename, sourceDatabase.sha256));
    if (input) await verify('inputUnchanged', () => sameFile(input.filename, input.sha256));
    if (sourceBindings) await verify('designatedSourcesUnchanged', async () => { for (const row of sourceBindings) await sameFile(row.path, row.sha256); });
    if (failures.length) { report.phaseAcceptance = false; failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Display preference observation input verification failed.'); }
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  return { native: first, report, output };
}

// A failed capture stays failed for this worker; it cannot silently replace
// the same-run input or overwrite the failed output with a retry.
function once(mode) {
  if (!captures.has(mode)) captures.set(mode, capture(mode));
  return captures.get(mode);
}
export const captureDisplayPreferences = () => once('http');
export const captureDisplayPreferenceSnapshot = () => once('snapshot');
