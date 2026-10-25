import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const root = new URL('./', import.meta.url), inputFile = new URL('./input.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const profile = JSON.parse(await readFile(new URL('./current-profile.json', root)));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readOutcome = row => ({ opened: row.opened, streamDisposed: row.streamDisposed,
  openFailed: Boolean(row.openError), readFailed: Boolean(row.readError), bytes: row.bytes, sha256: row.sha256, prefix: row.prefix });
const coverOutcome = row => ({ hasImage: row.hasImage, format: row.format, bytes: row.bytes, sha256: row.sha256,
  logs: row.logs.map(log => log.level), cancellationRequested: row.cancellationRequested });
const catalogOutcome = row => ({ archiveFailed: Boolean(row.archiveError), entries: row.entries.map(entry => ({
  ordinal: entry.ordinal, key: entry.key, size: entry.size, isDirectory: entry.isDirectory, read: readOutcome(entry.read) })) });
const functional = native => ({
  directoryCases: native.directoryCases.map(row => ({ name: row.name, sourceSha256: row.sourceSha256,
    catalog: catalogOutcome(row.catalog), cover: coverOutcome(row.cover), sourceUnlocked: row.sourceUnlocked })),
  selectedCases: native.selectedCases.map(row => ({ name: row.name, sourceSha256: row.sourceSha256,
    catalog: catalogOutcome(row.catalog), cover: coverOutcome(row.cover), sourceUnlocked: row.sourceUnlocked })),
  edgeCases: native.edgeCases.map(row => ({ name: row.name, sourceSha256: row.sourceSha256, explicitPassword: row.explicitPassword,
    observation: row.explicitPassword ? readOutcome(row.observation) : coverOutcome(row.observation), sourceUnlocked: row.sourceUnlocked })),
  cryptoCases: native.cryptoCases.map(({ selectedPath, streamType, salt, error, ...row }) => ({ ...row, failed: Boolean(error) }))
});

let pending;
export function captureCurrentRar() { return pending ??= capture(); }
async function capture() {
  const output = path.join(validationOutputRoot(), 'rar-entry-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: hash(inputBytes), captures: [], sourceBindings: [],
    assetBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, root)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sourceOffer = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    for (const relativePath of profile.sourcePaths) {
      const pinned = sourceOffer.files.find(entry => entry.path === relativePath);
      assert.ok(pinned, 'The designated source offer must include ' + relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pinned.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    const containedFile = async (filename, directory, expected) => {
      const relative = path.relative(directory, filename);
      assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), filename);
      const actual = await describeFile(filename);
      assert.equal(actual.bytes, expected.bytes, filename); assert.equal(actual.sha256, expected.sha256, filename);
    };
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/storage/fixtures/rar-entry-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/state', '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.actualComicImageProvider && native.actualArchiveReaders && native.actualCompressedEntryStreams, true);
      assert.equal(native.inputSha256, hash(inputBytes));
      for (const category of ['directoryCases', 'selectedCases', 'edgeCases', 'cryptoCases'])
        assert.deepEqual(native[category].map(row => row.name), input[category].map(row => row.name), category);
      for (const name of ['MediaBrowser.Providers', 'MediaBrowser.Controller', 'SharpCompress']) {
        const actual = native.assemblies.find(entry => entry.name === name);
        assert.ok(actual, 'The actual process must load ' + name);
        const supplied = await describeFile(path.join(build.runtime, name + '.dll'));
        assert.equal(actual.sha256, supplied.sha256, name);
      }
      for (const asset of native.assetBindings) {
        const source = fileURLToPath(new URL(input.assets[asset.name], root)), actual = await describeFile(source);
        assert.equal(path.resolve(asset.path), path.resolve(source));
        assert.equal(asset.bytes, actual.bytes); assert.equal(asset.sha256, actual.sha256);
        report.assetBindings.push({ label, ...asset });
      }
      for (const sample of [...native.directoryCases, ...native.selectedCases]) {
        await containedFile(sample.path, directory, { bytes: (await readFile(sample.path)).length, sha256: sample.sourceSha256 });
        assert.equal(sample.sourceUnlocked, true, sample.name);
        if (sample.cover.selectedPath) await containedFile(sample.cover.selectedPath, directory, sample.cover);
        for (const entry of sample.catalog.entries) await containedFile(entry.read.selectedPath, directory, entry.read);
      }
      for (const sample of native.edgeCases) {
        assert.equal(sample.sourceUnlocked, true, sample.name);
        await containedFile(sample.path, directory, { bytes: (await readFile(sample.path)).length, sha256: sample.sourceSha256 });
        if (sample.observation.selectedPath) await containedFile(sample.observation.selectedPath, directory, sample.observation);
      }
      for (const sample of native.cryptoCases) {
        assert.equal(sample.sourceUnlocked, true, sample.name);
        await containedFile(sample.selectedPath, directory, sample);
      }
      if (first) assert.deepEqual(functional(native), functional(first), 'Independent RAR captures preserve catalogs, bytes and failures');
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
export async function recordCandidate(kind, name, observation) {
  assert.match(kind, /^[A-Za-z0-9_.-]+$/u);
  const { output } = await captureCurrentRar(), directory = path.join(output, 'candidate', kind);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, encodeURIComponent(name) + '.json'), JSON.stringify({ name, ...observation }, null, 2) + '\n', { flag: 'wx' });
}
