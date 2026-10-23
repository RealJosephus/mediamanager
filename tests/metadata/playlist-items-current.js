import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializePlaylistFile } from '../../src/library/playlist-file.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const profileUrl = new URL('./fixtures/playlist-items-current/current-profile.json', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';

async function prepareWriters(input, output) {
  const result = [];
  for (const sample of input.writerCases) {
    const root = path.join(output, 'candidate', sample.name), media = path.join(root, 'media');
    for (const name of input.files) {
      const filename = path.join(media, ...name.split('/'));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, 'neutral media file', { flag: 'wx' });
    }
    const relative = 'Library/lists/node' + sample.extension, filename = path.join(media, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    const children = input.writerChildren.map(child => ({ ...child, Path: path.join(media, ...child.Path.split('/')),
      RunTimeTicks: BigInt(child.RunTimeTicks) }));
    let text = serializePlaylistFile(filename, input.writerLinks.map(index => children[index]),
      { windows: process.platform === 'win32' }).toString('utf8');
    if (sample.reorder) text = text.replace(/<media ([^>]+) \/>/gu, (_, attributes) =>
      '<media ' + attributes.match(/[A-Za-z]+="[^"]*"/gu).reverse().join(' ') + ' />');
    if (sample.bomLf) text = '\uFEFF' + text.replaceAll('\r\n', '\n');
    const bytes = Buffer.from(text);
    await writeFile(filename, bytes, { flag: 'wx' });
    result.push({ name: sample.name, currentWriter: true, path: relative, bytes: bytes.toString('base64'),
      candidateRoot: root, candidateFilename: filename, sha256: sha(bytes) });
  }
  return result;
}

let pending;
export const currentPlaylistItems = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const output = path.join(validationOutputRoot(), 'playlist-items-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
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
    const input = JSON.parse(await readFile(new URL('input.json', profileUrl), 'utf8'));
    for (const [field, count] of Object.entries(profile.cases)) {
      assert.equal(input[field].length, count, field);
      assert.equal(new Set(input[field].map(value => value.name)).size, count, field);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = manifest.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const candidateWriters = await prepareWriters(input, output);
    const bytes = Buffer.from(json({ input, candidateWriters })), inputFile = path.join(output, 'consumer-input.json');
    await writeFile(inputFile, bytes, { flag: 'wx' }); report.consumerInput = await describeFile(inputFile);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const directory = path.join(output, 'native');
    const record = await recordOracle({ project, output: directory,
      args: [inputFile, '{output}/native.json', '{output}/state'] });
    const nativeFile = path.join(directory, 'native.json'), nativeBytes = await readFile(nativeFile), native = JSON.parse(nativeBytes);
    report.capture = { record, observation: await describeFile(nativeFile) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === nativeFile)?.sha256, sha(nativeBytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha(bytes));
    for (const assembly of native.assemblies) {
      const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
    }
    assert.deepEqual(native.results.map(value => value.name), [...input.providerCases, ...candidateWriters].map(value => value.name));
    assert.deepEqual(native.merges.map(value => value.name), input.mergeCases.map(value => value.name));
    assert.deepEqual(native.writers.map(value => value.name), candidateWriters.map(value => value.name));
    for (const [index, writer] of candidateWriters.entries()) {
      const bytes = await readFile(writer.candidateFilename);
      assert.equal(sha(bytes), writer.sha256);
      assert.deepEqual(native.writers[index].before, { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
      assert.deepEqual(await readFile(native.writers[index].filename), Buffer.from(native.writers[index].after.base64, 'base64'));
    }
    report.nativeExecutionRecorded = true;
    const comparisons = [];
    const recordComparison = async value => {
      comparisons.push(value); await writeFile(path.join(output, 'comparison.json'), json(comparisons));
    };
    return { input, native, candidateWriters, output, report, recordComparison };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
