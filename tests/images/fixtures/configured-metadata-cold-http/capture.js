import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';
import { dateTicks } from '../../../../src/library/records.js';

const root = new URL('./', import.meta.url);
export const inputBytes = await readFile(new URL('./input.json', root));
export const input = JSON.parse(inputBytes);
export const picture = await readFile(new URL('../../../images/fixtures/processor/single.png', root));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const significantHeaders = ['content-type', 'content-length', 'content-language', 'content-disposition', 'etag', 'cache-control',
  'pragma', 'last-modified', 'vary', 'transfermode.dlna.org', 'realtimeinfo.dlna.org'];
export const wire = value => ({ name: value.name, status: value.status,
  headers: Object.fromEntries(significantHeaders.filter(name => value.headers[name] != null).map(name => [name, value.headers[name]])),
  body: value.body });
export const business = value => ({ ...value, images: value.images.map(image => ({ ...image,
  modified: image.modified == null ? null : dateTicks(image.modified) })) });

const sourcePaths = [
  'Jellyfin.Api/Controllers/ImageController.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'src/Jellyfin.Drawing/ImageProcessor.cs', 'src/Jellyfin.Drawing.Skia/SkiaEncoder.cs',
  'MediaBrowser.Providers/Manager/ProviderManager.cs', 'MediaBrowser.Providers/Manager/ImageSaver.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/Configuration/ServerConfigurationManager.cs',
  'Emby.Server.Implementations/ApplicationHost.cs', 'Emby.Server.Implementations/ServerApplicationPaths.cs',
  'Emby.Server.Implementations/IO/ManagedFileSystem.cs', 'Emby.Server.Implementations/Serialization/MyXmlSerializer.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
];
let pending;
export function currentColdMetadataImageNative() { return pending ??= capture(); }

async function capture() {
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'configured-metadata-cold-http-' + randomUUID()));
  await mkdir(output);
  const report = { historicalRecordingReused: false, nativeExecutionRecorded: false, inputs: [], sourceBindings: [], captures: [],
    scope: 'Real A image save and image SQL, persisted current B configuration, fresh Native paths/repository/controller/processor/PhysicalFile HTTP; Node cold runtime uses explicit Local metadata mappings. Full raw headers/bodies remain recorded; comparisons reuse existing image HTTP significant headers and retain volatile Date/Age/server/timing only as diagnostics.',
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const filename of ['input.json', 'Program.cs', 'Oracle.csproj', 'capture.js'])
      report.inputs.push(await describeFile(fileURLToPath(new URL(filename, root))));
    report.inputs.push(await describeFile(fileURLToPath(new URL('../../../images/fixtures/processor/single.png', root))));
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of sourcePaths) {
      const expected = manifest.files.find(value => value.path === relativePath); assert.ok(expected, relativePath);
      const actual = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(actual.available, true); assert.equal(actual.sha256, expected.sha256, relativePath);
      report.sourceBindings.push({ relativePath, actual });
    }
    let native;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('./Oracle.csproj', root)), output: directory,
        args: [fileURLToPath(new URL('./input.json', root)), '{output}/native.json',
          fileURLToPath(new URL('../../../images/fixtures/processor/single.png', root))] });
      const filename = path.join(directory, 'native.json'); report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      const bytes = await readFile(filename), observed = JSON.parse(bytes);
      assert.equal(record.outputs.find(value => value.filename === filename)?.sha256, hash(bytes));
      assert.equal(observed.inputSha256, hash(inputBytes)); assert.equal(observed.imageSha256, hash(picture));
      assert.deepEqual(observed.failures, []); assert.deepEqual(observed.diagnostics, []);
      assert.ok(Object.values(observed.cleanup).every(value => value === true));
      assert.equal(observed.business.images.length, 1);
      assert.equal(observed.business.images[0].Width, 1); assert.equal(observed.business.images[0].Height, 1);
      assert.ok(observed.business.images[0].blurhash?.length > 0);
      assert.equal(observed.business.metadataPath, '$STATE/metadata-b');
      assert.ok(observed.business.images[0].path.startsWith('$STATE/metadata-a/'));
      assert.deepEqual(observed.responses.map(value => value.name), input.cases.map(value => value.name));
      assert.deepEqual(observed.responses.map(value => value.status), [200, 200, 200, 304]);
      for (const response of observed.responses.filter(value => ['cold-original', 'cold-tagged'].includes(value.name))) {
        assert.equal(response.body.bytes, picture.length); assert.equal(response.body.sha256, hash(picture));
        assert.equal(response.body.base64, picture.toString('base64'));
      }
      for (const name of ['Jellyfin.Api', 'Jellyfin.Drawing', 'Jellyfin.Drawing.Skia', 'MediaBrowser.Providers', 'Jellyfin.Server.Implementations'])
        assert.ok(observed.assemblies.some(value => value.name === name), 'Executed source assembly provenance: ' + name);
      for (const assembly of observed.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256);
      }
      for (const assembly of observed.frameworkAssemblies) {
        const actual = await describeFile(assembly.filename); assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256);
      }
      for (const library of observed.nativeLibraries) {
        const rid = library.Name === 'skia' && process.platform === 'darwin' ? 'osx' : library.runtimeIdentifier;
        const actual = await describeFile(path.join(build.runtime, 'runtimes', rid, 'native', library.filename));
        assert.equal(actual.available, true); assert.equal(actual.sha256, library.sha256);
      }
      if (native) {
        assert.deepEqual(business(observed.business), business(native.business));
        assert.deepEqual(observed.responses.map(wire), native.responses.map(wire));
      } else native = observed;
    }
    const after = await verifyNativeBuild(); assert.equal(after.identitySha256, build.identitySha256);
    assert.equal(after.runtimeEntriesSha256, build.runtimeEntriesSha256);
    report.nativeExecutionRecorded = true; report.independentNativeCapturesAgree = true;
    return { output, native, report };
  } catch (error) { report.failure = failureValue(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export function failureValue(error, ancestors = []) {
  if (error == null || typeof error !== 'object') return error;
  if (ancestors.includes(error)) return { message: error.message, code: error.code, status: error.status, statusCode: error.statusCode, cycle: true };
  const next = [...ancestors, error];
  return Object.fromEntries(['name', 'message', 'code', 'status', 'statusCode', 'storageCode', 'errno', 'syscall', 'path', 'stack',
    'cause', 'errors', 'details', 'actual', 'expected', 'operator'].filter(key => key in error).map(key => [key,
    key === 'cause' ? failureValue(error.cause, next) : key === 'errors' ? [...error.errors].map(value => failureValue(value, next)) : error[key]]));
}

export async function recordColdMetadataImageCandidate(report) {
  const { output } = await currentColdMetadataImageNative();
  await writeFile(path.join(output, 'candidate.json'), json(report), { flag: 'wx' });
}
