import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializeNativeItemData, serializeNativeItemData } from '../../src/library/native-item-data.js';
import { idKey } from '../../src/library/records.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const root = new URL('./fixtures/guid-contract/', import.meta.url);
const inputFile = new URL('current/input.json', root), profileFile = new URL('current-profile.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const playlistType = 'MediaBrowser.Controller.Playlists.Playlist';
export const userViewType = 'MediaBrowser.Controller.Entities.UserView';
export const displayParentId = 'cb210000-0000-0000-0000-000000000007';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const diagnostic = error => ({ name: error.name, message: error.message, code: error.code });
export const functional = result => ({ success: result.success, value: result.value });
const observe = (item, nativeType) => nativeType === playlistType
  ? { owner: idKey(item.OwnerUserId), openAccess: item.OpenAccess }
  : { userId: item.UserId === null ? null : idKey(item.UserId), displayParentId: idKey(item.DisplayParentId) };

export function readCandidate(nativeType, data) {
  try {
    const item = deserializeNativeItemData(nativeType, data);
    return { success: true, value: observe(item, nativeType), serializedData: serializeNativeItemData(item), failure: null };
  } catch (error) { return { success: false, value: null, serializedData: null, failure: diagnostic(error) }; }
}

function prepareCandidate() {
  const cases = input.Cases.map(sample => {
    const data = JSON.stringify({ OwnerUserId: sample.Value, OpenAccess: true });
    const userViewData = JSON.stringify({ UserId: sample.Value, DisplayParentId: displayParentId });
    return { Name: sample.Name, value: sample.Value, data, playlist: readCandidate(playlistType, data),
      userViewData, userView: readCandidate(userViewType, userViewData) };
  });
  return { inputSha256: sha(inputBytes), cases };
}

let pending;
export const currentGuidContract = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  const output = path.join(validationOutputRoot(), 'guid-contract-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: sha(inputBytes), inputs: [], sourceBindings: [],
    loadedAssemblyBindings: [], nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, root)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      sourceEntriesSha256: build.sourceEntriesSha256, sdkEntriesSha256: build.sdkEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.available, true, relative); assert.equal(source.sha256, expected.sha256, relative);
      assert.equal(source.bytes, expected.size, relative); report.sourceBindings.push({ relativePath: relative, source });
    }
    const candidate = prepareCandidate(), candidateRoot = path.join(output, 'candidate'); await mkdir(candidateRoot);
    const candidateFile = path.join(candidateRoot, 'node-data.json');
    await writeFile(candidateFile, json(candidate), { flag: 'wx' });
    report.candidate = await describeFile(candidateFile);
    report.candidateSources = await Promise.all([
      './native-guid-contract.test.js', './native-guid-current-fixture.js', '../../src/users/native.js',
      '../../src/library/native-item-data.js', '../../src/library/native-item-entity.js', '../../src/library/records.js',
      '../../src/core/json-tokens.js', '../../src/core/json.js', '../../src/database/native-text.js',
      '../../src/database/postgres-runtime-schema.js',
    ].map(relative => describeFile(fileURLToPath(new URL(relative, import.meta.url)))));
    assert.ok(report.candidateSources.every(entry => entry.available));
    const nativeRoot = path.join(output, 'native');
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, root));
    const record = await recordOracle({ project, output: nativeRoot,
      args: [fileURLToPath(inputFile), candidateFile, '{output}/native.json'] });
    const filename = path.join(nativeRoot, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
    report.capture = { record, observation: await describeFile(filename) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha(inputBytes));
    assert.equal(native.candidateSha256, report.candidate.sha256);
    assert.deepEqual(native.cases.map(row => ({ Name: row.Name, Value: row.value })), input.Cases);
    assert.deepEqual(native.nodeReads.map(row => row.Name), input.Cases.map(row => row.Name));
    for (const assembly of native.assemblies) {
      const loaded = await describeFile(assembly.filename);
      assert.equal(loaded.available, true, assembly.name); assert.equal(loaded.sha256, assembly.sha256, assembly.name);
      const sdkRelative = path.relative(build.sdkRoot, assembly.filename);
      let supplied, origin;
      if (path.resolve(assembly.filename) === path.resolve(record.oracleAssembly.filename)) {
        supplied = record.oracleAssembly; origin = 'current-oracle';
      } else if (sdkRelative && !sdkRelative.startsWith('..' + path.sep) && sdkRelative !== '..' && !path.isAbsolute(sdkRelative)) {
        const entry = build.sdkAfter.files.find(row => row.path === sdkRelative.split(path.sep).join('/'));
        assert.ok(entry, assembly.name); supplied = entry; origin = 'same-run-sdk';
      } else {
        supplied = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(supplied.available, true, assembly.name); origin = 'same-run-native-runtime';
      }
      assert.equal(supplied.sha256, loaded.sha256, assembly.name); assert.equal(supplied.bytes, loaded.bytes, assembly.name);
      report.loadedAssemblyBindings.push({ name: assembly.name, origin, loaded, supplied });
    }
    for (const name of ['System.Private.CoreLib', 'Jellyfin.Extensions', 'Jellyfin.Server.Implementations',
      'Jellyfin.Database.Implementations', 'MediaBrowser.Controller']) assert.ok(native.assemblies.some(row => row.name === name), name);
    report.nativeExecutionRecorded = true;
    return { native, candidate, output, report };
  } catch (error) { report.error = { ...diagnostic(error), stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordCandidate(name, observation) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await currentGuidContract();
  const filename = path.join(output, 'candidate', name + '.json');
  await writeFile(filename, json(observation), { flag: 'wx' });
  await writeFile(filename + '.receipt.json', json(await describeFile(filename)), { flag: 'wx' });
}
