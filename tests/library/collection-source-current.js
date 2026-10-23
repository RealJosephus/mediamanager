import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const fixture = new URL('./fixtures/collection-source/', import.meta.url);
const inputFile = new URL('current/input.json', fixture);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';

export function collectionSourceObservation(native) {
  return { roots: native.rootItems, boxes: native.boxes, rows: native.rows, ancestors: native.ancestors, links: native.links,
    pages: native.pages.map(page => ({ sample: page.sample, failed: Boolean(page.failure), rows: page.rows ?? null })) };
}

let pending;
export const currentCollectionSource = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await readFile(new URL('current-profile.json', fixture), 'utf8'));
  const output = path.join(validationOutputRoot(), 'collection-source-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, fixture)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, expected.sha256, relative); report.sourceBindings.push({ relativePath: relative, source });
    }
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('current/Oracle.csproj', fixture)), output: directory,
        args: ['{output}', fileURLToPath(inputFile), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename);
      const native = parseLosslessJson(bytes.toString('utf8'));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const flag of ['actualLibraryManager', 'actualFolderChildren', 'actualRepository', 'actualSqlite']) assert.equal(native[flag], true, flag);
      assert.deepEqual(native.pages.map(page => page.sample), input.Queries);
      for (const assembly of native.assemblies) {
        const actual = await describeFile(assembly.filename);
        assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.filename);
      }
      for (const name of ['Emby.Server.Implementations', 'Jellyfin.Server.Implementations', 'MediaBrowser.Controller', 'Jellyfin.Database.Implementations']) {
        const assembly = native.assemblies.find(entry => entry.name === name); assert.ok(assembly, name);
        assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
      }
      const sqlite = native.sqliteRuntime;
      const actual = await describeFile(sqlite.filename);
      const supplied = await describeFile(path.join(build.runtime, 'runtimes', sqlite.runtimeIdentifier, 'native', sqlite.name));
      assert.equal(actual.available, true); assert.equal(supplied.available, true);
      assert.equal(actual.sha256, sqlite.sha256); assert.equal(supplied.sha256, sqlite.sha256);
      observations.push(native);
    }
    assert.deepEqual(collectionSourceObservation(observations[1]), collectionSourceObservation(observations[0]));
    report.nativeExecutionRecorded = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: observations[0], repeat: observations[1], output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordCollectionCandidate(name, value) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await currentCollectionSource();
  await writeFile(path.join(output, 'candidate', name + '.json'), json(value), { flag: 'wx' });
}
