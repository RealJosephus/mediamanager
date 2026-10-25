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
const root = new URL('./', import.meta.url), inputFile = new URL('input.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
const profile = JSON.parse(await readFile(new URL('current-profile.json', root)));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const assetBytes = sample => readFile(new URL(sample.filename, root));
export const functional = native => native.results.map(sample => ({ name: sample.name, inputSha256: sample.inputSha256,
  original: sample.original, sourceUnchanged: sample.sourceUnchanged, sourceUnlocked: sample.sourceUnlocked,
  hashes: sample.hashes.map(row => ({ name: row.name, dimensions: row.dimensions, value: row.value, failed: row.error != null })) }));

let pending;
export function captureCurrentNative() { return pending ??= capture(); }

async function capture() {
  const output = path.join(validationOutputRoot(), 'jpeg-boundaries-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, identity: input.identity, inputSha256: hash(inputBytes), scope: profile.scope,
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, root)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const generation = JSON.parse(await readFile(new URL('generation-receipt.json', root)));
    assert.equal(generation.status, 'generated'); assert.equal(generation.nativeResultsRecorded, false);
    assert.equal(generation.runId, profile.generation.runId); assert.equal(generation.commit, profile.generation.commit);
    const producer = generation.sourceInputs.find(entry => entry.role === 'neutral-pixel-pattern-producer');
    const producerBytes = await readFile(new URL(producer.filename, root));
    assert.equal(producerBytes.length, producer.bytes); assert.equal(hash(producerBytes), producer.sha256);
    for (const entry of generation.assets) {
      const bytes = await readFile(new URL('assets/' + entry.filename, root));
      assert.equal(bytes.length, entry.bytes, entry.filename); assert.equal(hash(bytes), entry.sha256, entry.filename);
    }
    const scaleGeneration = JSON.parse(await readFile(new URL('scale-source/generation-receipt.json', root)));
    const scaleDeclaration = JSON.parse(await readFile(new URL('scale-source/input-declaration.json', root)));
    assert.equal(scaleGeneration.status, 'generated'); assert.equal(scaleGeneration.nativeResultsRecorded, false);
    assert.equal(scaleGeneration.expectedPixelsRecorded, false); assert.equal(scaleGeneration.decoderResultsRecorded, false);
    assert.equal(scaleGeneration.sourceUnchangedDuringGeneration, true); assert.equal(scaleGeneration.generationInputsUnchanged, true);
    assert.equal(scaleGeneration.runId, profile.scaleGeneration.runId); assert.equal(scaleGeneration.commit, profile.scaleGeneration.commit);
    assert.deepEqual(scaleGeneration.assets.map(row => row.name), scaleDeclaration.images.map(row => row.name));
    const sourceCheck = async entry => {
      const bytes = await readFile(new URL('scale-source/' + entry.filename, root));
      assert.equal(bytes.length, entry.bytes, entry.filename); assert.equal(hash(bytes), entry.sha256, entry.filename);
    };
    for (const entry of scaleGeneration.assets) {
      await sourceCheck(entry);
      const sample = input.images.find(row => row.name === entry.name);
      assert.equal(sample.filename, 'scale-source/' + entry.filename);
      assert.deepEqual(sample.sourceDimensions, { Width: entry.header.width, Height: entry.header.height });
    }
    for (const entry of scaleGeneration.sourceInputs) if (entry.role !== 'actual-runner-c-compiler-driver') await sourceCheck(entry);
    const aliases = JSON.parse(await readFile(new URL('alias-source.json', root)));
    for (const entry of aliases.aliases) {
      const bytes = await readFile(new URL(entry.filename, root)), original = await readFile(new URL(entry.source, root));
      assert.deepEqual(bytes, original, entry.filename + ': identical original bytes');
      assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    for (const relativePath of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relativePath);
      assert.ok(pinned, 'The designated source offer must include ' + relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pinned.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/images/fixtures/jpeg-boundaries-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/pixels', '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      const capture = { label, record, observation: await describeFile(filename), pixels: [] };
      report.captures.push(capture);
      assert.equal(record.passed, true); assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.actualSkiaJpegCodec, true); assert.equal(native.actualBlurHashSharp, true); assert.equal(native.actualImageProcessor, true);
      assert.equal(native.inputSha256, hash(inputBytes));
      assert.deepEqual(native.results.map(sample => sample.name), input.images.map(sample => sample.name));
      for (const [index, sample] of native.results.entries()) {
        assert.equal(sample.inputSha256, hash(await assetBytes(input.images[index])), sample.name);
        assert.equal(sample.sourceUnchanged, true, sample.name); assert.equal(sample.sourceUnlocked, true, sample.name);
        if (input.images[index].sourceDimensions) assert.deepEqual(sample.original, input.images[index].sourceDimensions, sample.name);
        const requests = ['full', 'max128', ...(input.images[index].thresholds ? input.thresholdScales.map(row => row.name) : [])];
        assert.deepEqual(sample.decoded.map(row => row.name), requests, sample.name);
        const dimensions = input.images[index].hashDimensions ?? sample.original;
        assert.deepEqual(sample.hashDimensions, dimensions, sample.name + ': public caller dimensions');
        const hashRequests = [{ name: 'original', ...dimensions }, ...(input.images[index].thresholds ? input.cachedDimensions : [])];
        assert.deepEqual(sample.hashes.map(row => ({ name: row.name, ...row.dimensions })), hashRequests, sample.name);
        for (const row of sample.decoded) if (row.pixelPath != null) {
          const descriptor = await describeFile(row.pixelPath);
          assert.equal(descriptor.sha256, row.sha256, sample.name + ': ' + row.name);
          assert.equal(descriptor.bytes, row.bytes); assert.equal(row.bytes, row.Width * row.Height * 4);
          capture.pixels.push(descriptor);
        }
      }
      for (const assembly of native.assemblies)
        assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.name);
      const rid = process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? 'osx' : 'linux-x64';
      const library = path.join(build.runtime, 'runtimes', rid, 'native', path.basename(native.nativeLibrary.filename));
      assert.equal(native.nativeLibrary.sha256, (await describeFile(library)).sha256);
      if (first) assert.deepEqual(functional(native), functional(first), 'Independent native observations');
      else first = native;
    }
    report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, output };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(name, observation, pixels) {
  const { output } = await captureCurrentNative(), basename = encodeURIComponent(name);
  if (pixels) await writeFile(path.join(output, 'candidate', basename + '.rgba'), pixels, { flag: 'wx' });
  await writeFile(path.join(output, 'candidate', basename + '.json'), JSON.stringify({ name, ...observation }, null, 2) + '\n', { flag: 'wx' });
}
