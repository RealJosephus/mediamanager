import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const root = new URL('./', import.meta.url);
export const picture = await readFile(new URL('../../../images/fixtures/processor/single.png', root));
export const previousPicture = await readFile(new URL('../../../images/fixtures/http/backdrop.jpg', root));
export const input = JSON.parse(await readFile(new URL('./input.json', root), 'utf8'));
const sources = [
  'MediaBrowser.Providers/Manager/ProviderManager.cs', 'MediaBrowser.Providers/Manager/ImageSaver.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Movies/Movie.cs',
  'Emby.Server.Implementations/ServerApplicationPaths.cs', 'Emby.Server.Implementations/ApplicationHost.cs',
  'Emby.Server.Implementations/Configuration/ServerConfigurationManager.cs',
  'Emby.Server.Implementations/IO/ManagedFileSystem.cs', 'Emby.Server.Implementations/Serialization/MyXmlSerializer.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
];
let pending;
export function currentConfiguredImagePathsNative() { return pending ??= capture(); }

async function capture() {
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'configured-image-paths-' + randomUUID()));
  await mkdir(output);
  const report = { historicalRecordingReused: false, nativeExecutionRecorded: false, captures: [], inputs: [], sourceBindings: [],
    scope: 'Three actual metadata-path boundaries: completed URL download, opened image target before copy, and SaveItems row mapping. Paths, image files/bytes, SQLite image/item rows and current cold reads; no CLR identity or private counter acceptance.',
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const filename of [new URL('./input.json', root), new URL('./Program.cs', root), new URL('./Oracle.csproj', root),
      new URL('./capture.js', root), new URL('../../../images/fixtures/processor/single.png', root), new URL('../../../images/fixtures/http/backdrop.jpg', root)])
      report.inputs.push(await describeFile(fileURLToPath(filename)));
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of sources) {
      const expected = manifest.files.find(value => value.path === relativePath); assert.ok(expected, relativePath);
      const actual = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(actual.sha256, expected.sha256, relativePath); report.sourceBindings.push({ relativePath, actual });
    }
    let native;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('./Oracle.csproj', root)), output: directory,
        args: [fileURLToPath(new URL('./input.json', root)), '{output}/native.json',
          fileURLToPath(new URL('../../../images/fixtures/processor/single.png', root)),
          fileURLToPath(new URL('../../../images/fixtures/http/backdrop.jpg', root))] });
      const filename = path.join(directory, 'native.json');
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      const bytes = await readFile(filename), observed = JSON.parse(bytes);
      assert.equal(record.outputs.find(value => value.filename === filename)?.sha256, hash(bytes));
      assert.equal(observed.inputSha256, hash(await readFile(new URL('./input.json', root))));
      assert.equal(observed.imageSha256, hash(picture)); assert.equal(observed.previousImageSha256, hash(previousPicture));
      assert.deepEqual(observed.failures, []); assert.deepEqual(observed.results.map(value => value.name), input.map(value => value.name));
      for (const name of ['jellyfin', 'Emby.Server.Implementations', 'MediaBrowser.Controller', 'MediaBrowser.Providers', 'Jellyfin.Server.Implementations'])
        assert.ok(observed.assemblies.some(value => value.name === name), 'The executed source assembly must be recorded: ' + name);
      for (const assembly of observed.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.available, true, assembly.name); assert.equal(assembly.sha256, actual.sha256, assembly.name);
      }
      const sqlite = await describeFile(path.join(build.runtime, 'runtimes', observed.sqlite.runtimeIdentifier, 'native', observed.sqlite.name));
      assert.equal(sqlite.available, true); assert.equal(sqlite.sha256, observed.sqlite.sha256);
      report.captures.at(-1).sqlite = { loaded: observed.sqlite, supplied: sqlite };
      assert.equal(observed.results.find(value => value.name === 'path-update-after-target-open').resources.sourceClosed, true);
      assert.ok(observed.results.every(value => value.resources.serverClosed));
      if (native) assert.deepEqual(observed.results.map(value => value.business), native.results.map(value => value.business));
      else native = observed;
    }
    const after = await verifyNativeBuild(); assert.equal(after.identitySha256, build.identitySha256);
    assert.equal(after.runtimeEntriesSha256, build.runtimeEntriesSha256);
    report.nativeExecutionRecorded = true; report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { output, native, report };
  } catch (error) { report.error = failureValue(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export function failureValue(error, ancestors = []) {
  if (error == null || typeof error !== 'object') return error;
  if (ancestors.includes(error)) return { message: error.message, code: error.code, status: error.status, statusCode: error.statusCode, cycle: true };
  const next = [...ancestors, error];
  return Object.fromEntries(['name', 'message', 'code', 'status', 'statusCode', 'storageCode', 'errno', 'syscall', 'path', 'stack', 'cause', 'errors', 'details', 'actual', 'expected', 'operator']
    .filter(key => key in error).map(key => [key, key === 'errors' ? [...error.errors].map(value => failureValue(value, next))
      : key === 'cause' ? failureValue(error.cause, next) : error[key]]));
}

export async function recordConfiguredImagePathsCandidate(name, observation) {
  const { output } = await currentConfiguredImagePathsNative();
  assert.ok(input.some(value => value.name === name));
  await writeFile(path.join(output, 'candidate', name + '.json'), json(observation), { flag: 'wx' });
}
