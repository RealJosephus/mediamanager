import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const fixtureRoot = new URL('./', import.meta.url);
export const inputFile = new URL('./input.json', import.meta.url);
export const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const profile = JSON.parse(await readFile(new URL('../book-comic/current-profile.json', import.meta.url)));
const assetManifest = JSON.parse(await readFile(new URL('./assets.json', import.meta.url)));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const localMetadata = result => {
  if (!result) return result;
  const { ResultLanguage, ...metadata } = result;
  return metadata;
};
const metadataOutcome = row => ({ name: row.name, provider: row.provider, changed: row.changed,
  changeFailed: Boolean(row.changeError), failed: Boolean(row.error), trace: row.trace, result: localMetadata(row.result),
  source: { exists: row.source.exists, kind: row.source.kind, modified: row.source.modified } });
const coverOutcome = row => ({ name: row.name, culture: row.culture, hasImage: row.hasImage, format: row.format,
  bytes: row.bytes, sha256: row.sha256, sourceUnlocked: row.sourceUnlocked });
function functionalNative(native) {
  return { results: native.results.map(metadataOutcome), covers: native.covers.map(coverOutcome) };
}
const imageOutcome = sample => ({ name: sample.name, saveLocal: sample.saveLocal, sourceSha256: sample.sourceSha256,
  selected: sample.selected, refreshFailed: Boolean(sample.refreshError), updateFailed: Boolean(sample.updateError),
  refresh: sample.refresh && { update: sample.refresh.update, Failures: sample.refresh.Failures },
  saves: sample.saves, files: sample.files.map(({ bytes, sha256 }) => ({ bytes, sha256 })),
  images: sample.images.map(({ Width, Height, BlurHash, Type }) => ({ Width, Height, BlurHash, Type })),
  rows: sample.rows.map(({ Width, Height, Blurhash, ImageType }) => ({ Width, Height, Blurhash, ImageType })) });

async function bindAssemblies(native, build, names) {
  for (const name of names) {
    const actual = native.assemblies.find(entry => path.basename(entry.path) === name + '.dll');
    assert.ok(actual, 'The actual process must load ' + name);
    const supplied = await describeFile(path.join(build.runtime, name + '.dll'));
    assert.equal(actual.sha256, supplied.sha256, name);
  }
}

let pending;
export function captureCurrentComic() { return pending ??= capture(); }
async function capture() {
  const output = path.join(validationOutputRoot(), 'book-comic-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: hash(inputBytes), captures: [],
    sourceBindings: [], assetBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sourceOffer = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = sourceOffer.files.find(entry => entry.path === relative);
      assert.ok(pinned, 'The designated source offer must include ' + relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    for (const asset of assetManifest.assets) {
      const filename = fileURLToPath(new URL(asset.filename, fixtureRoot));
      const actual = await describeFile(filename);
      assert.equal(actual.bytes, asset.bytes, asset.filename);
      assert.equal(actual.sha256, asset.sha256, asset.filename);
      report.assetBindings.push({ ...asset, actual });
    }
    let first, consumer;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/metadata/fixtures/book-comic-current/Oracle.csproj', output: directory,
        args: ['{output}/state', fileURLToPath(inputFile),
          fileURLToPath(new URL('../../../images/fixtures/splashscreen/assets/portrait.png', import.meta.url)),
          fileURLToPath(new URL('../../../images/fixtures/splashscreen/assets/portrait.jpg', import.meta.url)),
          '{output}/native.json', fileURLToPath(new URL('./assets/', import.meta.url))] });
      const filename = path.join(directory, 'native.json'), native = JSON.parse(await readFile(filename));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(native.actualProviders && native.actualComicReaders && native.actualArchiveEngines, true);
      assert.equal(native.inputSha256, hash(inputBytes));
      assert.equal(native.results.length, input.metadataCases.length * 4);
      assert.deepEqual(native.covers.map(row => row.name), input.coverCases.map(row => row.name));
      await bindAssemblies(native, build, ['MediaBrowser.Providers', 'MediaBrowser.Controller']);
      for (const asset of native.assets) {
        assert.ok(path.resolve(asset.path).startsWith(path.resolve(directory) + path.sep), asset.path);
        const actual = await describeFile(asset.path);
        assert.equal(actual.bytes, asset.bytes); assert.equal(actual.sha256, asset.sha256);
      }
      assert.ok(native.covers.every(row => row.sourceUnlocked));
      for (const row of native.covers.filter(row => row.hasImage)) {
        const actual = await describeFile(row.coverPath);
        assert.equal(actual.bytes, row.bytes); assert.equal(actual.sha256, row.sha256);
      }
      if (first) assert.deepEqual(functionalNative(native), functionalNative(first), 'Independent Comic captures');
      else first = native;
    }
    for (const label of ['image-first', 'image-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/metadata/fixtures/book-comic-current/image-consumer/Oracle.csproj', output: directory,
        args: ['{output}/state', fileURLToPath(new URL('./assets/', import.meta.url)), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), observed = JSON.parse(await readFile(filename));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      for (const flag of ['actualComicImageProvider', 'actualItemImageProvider', 'actualProviderManagerStreamSave',
        'actualImageSaver', 'actualLibraryManagerUpdateImages', 'actualImageProcessorAndSkia', 'actualSqlitePersistence'])
        assert.equal(observed[flag], true, flag);
      await bindAssemblies(observed, build, ['MediaBrowser.Providers', 'MediaBrowser.Controller', 'Jellyfin.Server.Implementations']);
      const rid = { win32: 'win', linux: 'linux', darwin: 'osx' }[process.platform] + '-' + process.arch;
      for (const library of observed.nativeLibraries) {
        const runtime = library.name === 'skia' && process.platform === 'darwin' ? 'osx' : rid;
        const supplied = await describeFile(path.join(build.runtime, 'runtimes', runtime, 'native', path.basename(library.path)));
        assert.equal(library.sha256, supplied.sha256, library.name);
      }
      assert.equal(observed.results.length, 6);
      for (const sample of observed.results) for (const file of sample.files) {
        assert.ok(path.resolve(file.path).startsWith(path.resolve(directory) + path.sep), file.path);
        const actual = await describeFile(file.path);
        assert.equal(actual.bytes, file.bytes); assert.equal(actual.sha256, file.sha256);
      }
      if (consumer) assert.deepEqual(observed.results.map(imageOutcome), consumer.results.map(imageOutcome), 'Independent saved-image captures');
      else consumer = observed;
    }
    report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, consumer, output, report };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(kind, name, value) {
  assert.match(kind, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await captureCurrentComic(), directory = path.join(output, 'candidate', kind);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, encodeURIComponent(name) + '.json'), JSON.stringify({ name, ...value }, null, 2) + '\n', { flag: 'wx' });
}
