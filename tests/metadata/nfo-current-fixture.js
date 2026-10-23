import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function nfoInputBytes(sample) {
  const encoding = sample.encoding ?? 'utf8';
  if (encoding === 'utf8-markers') return Buffer.from(sample.text.replaceAll('{{NUL}}', '\0'));
  if (encoding === 'utf8-malformed') {
    const [before, after] = sample.text.split('{{BAD_UTF8}}');
    return Buffer.concat([Buffer.from(before), Buffer.from([0xc3, 0x28]), Buffer.from(after)]);
  }
  const encodings = { utf8: ['utf8'], 'utf8-bom': ['utf8', [0xef, 0xbb, 0xbf]],
    'utf16le-bom': ['utf16le', [0xff, 0xfe]], 'utf16le-no-bom': ['utf16le'] };
  if (encodings[encoding]) {
    const [codec, preamble = []] = encodings[encoding];
    return Buffer.concat([Buffer.from(preamble), Buffer.from(sample.text, codec)]);
  }
  const littleEndian = encoding === 'utf32le-bom';
  if (littleEndian || encoding === 'utf32be-bom') {
    const scalars = [...sample.text].map(character => character.codePointAt(0));
    const bytes = Buffer.alloc(4 + scalars.length * 4);
    bytes.writeUInt32BE(littleEndian ? 0xfffe0000 : 0x0000feff, 0);
    scalars.forEach((scalar, index) => bytes[littleEndian ? 'writeUInt32LE' : 'writeUInt32BE'](scalar, 4 + index * 4));
    return bytes;
  }
  if (encoding === 'utf16be-bom') {
    const little = Buffer.from(sample.text, 'utf16le'), bytes = Buffer.alloc(2 + little.length);
    bytes[0] = 0xfe; bytes[1] = 0xff;
    for (let index = 0; index < little.length; index += 2) { bytes[index + 2] = little[index + 1]; bytes[index + 3] = little[index]; }
    return bytes;
  }
  throw new Error(`Unknown neutral NFO encoding ${encoding}`);
}

function functionalItem({ runtimeType, nameUtf16, overviewUtf16, ...item }) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
    typeof value === 'string' ? value.toWellFormed() : value]));
}

export function functionalNfo(result) {
  const projected = { failed: Boolean(result.exception), hasMetadata: result.hasMetadata,
    item: functionalItem(result.item), people: result.people };
  if (result.calls) Object.assign(projected, {
    remoteImages: result.remoteImages, localImages: result.localImages,
    calls: result.calls.map(({ tokenCanBeCanceled, tokenIsCancellationRequested, ...call }) => call),
    userData: result.userData,
  });
  return projected;
}

export async function currentNfoFixture(profileUrl) {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  assert.equal(profile.schemaVersion, 1);
  const scenarios = profile.inputs.filter(entry => ['scenarios', 'layouts'].includes(entry.role));
  const groups = await Promise.all(scenarios.map(async entry => JSON.parse(await readFile(new URL(entry.filename, profileUrl), 'utf8'))));
  const input = groups.flat();
  assert.equal(groups[0].length, profile.baseCases);
  assert.equal(groups.slice(1).flat().length, profile.layoutCases);
  assert.equal(new Set(input.map(sample => sample.name)).size, input.length);
  let pending;
  const capture = () => pending ??= captureNative();
  async function captureNative() {
    const output = path.join(validationOutputRoot(), profile.fixture + '-current-' + randomUUID());
    assertValidationOutputChild(output);
    await mkdir(output);
    const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [],
      nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
    try {
      for (const expected of profile.inputs) {
        const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
        assert.equal(actual.available, true, expected.filename);
        assert.equal(actual.bytes, expected.bytes, expected.filename);
        assert.equal(actual.sha256, expected.sha256, expected.filename);
        report.inputs.push({ role: expected.role, ...actual });
      }
      const build = await verifyNativeBuild();
      report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
        receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
      const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
      for (const relative of profile.sourcePaths) {
        const pinned = sources.files.find(entry => entry.path === relative);
        assert.ok(pinned, 'The designated source offer must include ' + relative);
        const source = await describeFile(path.join(build.root, 'source', relative));
        assert.equal(source.sha256, pinned.sha256, relative);
        report.sourceBindings.push({ relativePath: relative, source });
      }
      const inputFile = path.join(output, 'scenarios.json'), inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
      await writeFile(inputFile, inputBytes, { flag: 'wx' });
      report.scenarios = await describeFile(inputFile);
      const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
      const directory = path.join(output, 'native');
      const record = await recordOracle({ project, output: directory, args: [inputFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.capture = { record, observation: await describeFile(filename) };
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha256(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha256(inputBytes));
      for (const assembly of native.assemblies) {
        const bound = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(bound.available, true, assembly.name);
        assert.equal(bound.sha256, assembly.sha256, assembly.name);
      }
      assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
      for (const [index, sample] of input.entries()) {
        const expectedBytes = nfoInputBytes(sample), result = native.results[index];
        const actualBytes = await readFile(path.join(directory, 'nfo-inputs', String(index).padStart(3, '0') + '.nfo'));
        assert.deepEqual(actualBytes, expectedBytes, sample.name + ': Native input file');
        assert.equal(result.raw.base64, expectedBytes.toString('base64'), sample.name);
        assert.equal(result.raw.bytes, expectedBytes.length, sample.name);
        assert.equal(result.raw.sha256, sha256(expectedBytes), sample.name);
      }
      report.nativeExecutionRecorded = true;
      return { native, output, report };
    } catch (error) {
      report.error = { name: error.name, message: error.message, stack: error.stack };
      throw error;
    } finally {
      await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
  }
  async function recordCandidate(label, observations) {
    assert.match(label, /^[a-zA-Z0-9_.-]+$/u);
    const { output } = await capture();
    await writeFile(path.join(output, 'candidate-' + label + '.json'), JSON.stringify(observations,
      (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
  }
  return { input, baseInput: groups[0], layoutInput: groups.slice(1).flat(), profile, capture, recordCandidate };
}
