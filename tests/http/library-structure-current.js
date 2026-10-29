import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { projectStructureObservation } from './fixtures/library-structure-current/observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const profileUrl = new URL('./fixtures/library-structure-current/current-profile.json', import.meta.url);
export const structureInput = JSON.parse(await readFile(new URL('input.json', profileUrl), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
let pending;
let archiveOutput;
const fileStateRoots = [];
export const currentLibraryStructure = () => pending ??= capture();

export async function archiveStructureFiles() {
  if (!archiveOutput) return;
  const receipts = [];
  for (const root of fileStateRoots) {
    let entries;
    try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Preserve real host filenames losslessly when artifact transport cannot
    // carry a colon, backslash or another valid Unix filename character.
    if (!entries.some(entry => /[\x00-\x1f<>:"\\|?*]/u.test(entry.name))) continue;
    const role = path.relative(archiveOutput, root).split(path.sep).join('/'), files = [];
    for (const entry of entries) {
      assert.ok(entry.isFile() || entry.isDirectory(), 'Only isolated regular file states may be archived.');
      const filename = path.join(entry.parentPath, entry.name), information = await stat(filename);
      const bytes = entry.isFile() ? await readFile(filename) : null;
      files.push({ path: path.relative(root, filename).split(path.sep).join('/'), kind: entry.isDirectory() ? 'directory' : 'file',
        modified: information.mtime.toISOString(), bytes: bytes?.length ?? null, sha256: bytes ? sha(bytes) : null,
        bytesBase64: bytes?.toString('base64') ?? null });
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const bytes = Buffer.from(json({ schemaVersion: 1, root: role, entries: files }));
    const filename = path.join(archiveOutput, 'file-state-' + sha(Buffer.from(role)).slice(0, 16) + '.json.gz');
    await writeFile(filename, gzipSync(bytes), { flag: 'wx' });
    assert.deepEqual(gunzipSync(await readFile(filename)), bytes, 'The portable archive retains every original path and file byte.');
    receipts.push({ root: role, entries: files.length, contentSha256: sha(bytes), archive: await describeFile(filename) });
    assertValidationOutputChild(root);
    assert.equal(path.relative(await realpath(archiveOutput), await realpath(root)), path.relative(archiveOutput, root));
    await rm(root, { recursive: true });
  }
  await writeFile(path.join(archiveOutput, 'file-state-archives.json'), json({ archives: receipts }), { flag: 'wx' });
}

async function verifyAssemblies(native, build) {
  const required = ['Jellyfin.Api', 'MediaBrowser.Controller', 'MediaBrowser.Model', 'Emby.Server.Implementations', 'jellyfin'];
  for (const name of required) assert.ok(native.assemblies.some(entry => entry.name === name), name);
  for (const assembly of native.assemblies) {
    const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
    assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
  }
}

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const output = path.join(validationOutputRoot(), 'library-structure-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  archiveOutput = output;
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, independentRepeatAgrees: false, actualNativeInstance: false,
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    assert.equal(structureInput.cases.length, profile.cases.http);
    assert.equal(new Set(structureInput.cases.map(sample => sample.name)).size, profile.cases.http);
    assert.equal(structureInput.markerTypes.length, profile.cases.markers);
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = manifest.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative); report.sourceBindings.push({ relativePath: relative, source });
    }
    const inputBytes = await readFile(new URL('input.json', profileUrl)), inputFile = path.join(output, 'consumer-input.json');
    await writeFile(inputFile, inputBytes, { flag: 'wx' }); report.consumerInput = await describeFile(inputFile);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const oracle = await compileOracle({ project, output: path.join(output, 'build') });
    report.oracleBuild = oracle.buildRecord;
    const natives = [], projections = [];
    for (let iteration = 1; iteration <= 2; iteration++) {
      const directory = path.join(output, 'native-' + iteration);
      fileStateRoots.push(path.join(directory, 'states'));
      const record = await oracle.record({ output: directory, args: [inputFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      const capture = { iteration, record, observation: await describeFile(filename), files: [] };
      report.captures.push(capture);
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const field of ['actualExecution', 'actualController', 'actualBinding', 'actualPermissionHandlers', 'actualRenameFiles',
        'actualCollectionFolderOptions', 'actualFiles', 'principalControlled', 'managerControlled']) assert.equal(native[field], true, field);
      assert.equal(native.actualNativeInstance, false); await verifyAssemblies(native, build);
      assert.deepEqual(native.results.map(row => row.name), structureInput.cases.map(sample => sample.name));
      assert.deepEqual(native.markerTypes.map(row => row.text), structureInput.markerTypes);
      for (const row of native.results) {
        assertValidationOutputChild(row.views);
        for (const file of row.files.filter(file => file.kind === 'file')) {
          const filename = path.join(row.views, ...file.path.split('/'));
          assertValidationOutputChild(filename);
          const actual = await describeFile(filename); assert.equal(actual.available, true);
          assert.equal(actual.sha256, sha(Buffer.from(file.bytesBase64, 'base64')), row.name + '/' + file.path);
          capture.files.push({ name: row.name, ...actual });
        }
      }
      natives.push(native); projections.push(native.results.map((row, index) => projectStructureObservation(row, structureInput.cases[index])));
    }
    await writeFile(path.join(output, 'native-comparison.json'), json({ first: projections[0], repeat: projections[1] }), { flag: 'wx' });
    assert.deepEqual(projections[1], projections[0], 'independent current Native HTTP, files, options and failure prefixes agree');
    assert.deepEqual(natives[1].markerTypes, natives[0].markerTypes);
    report.nativeExecutionRecorded = true; report.independentRepeatAgrees = true;
    const candidateRoot = path.join(output, 'candidate'); await mkdir(candidateRoot);
    fileStateRoots.push(candidateRoot);
    const candidates = new Map();
    const recordCandidate = async row => {
      assert.ok(structureInput.cases.some(sample => sample.name === row.name));
      await writeFile(path.join(candidateRoot, row.name, 'observation.json'), json(row), { flag: 'wx' });
      candidates.set(row.name, row);
    };
    const continueOptions = async cases => {
      const continuation = { cases, changes: structureInput.optionsContinuation };
      const filename = path.join(output, 'options-consumer-input.json'); await writeFile(filename, json(continuation), { flag: 'wx' });
      const record = await oracle.record({ output: path.join(output, 'options-native-continuation'),
        args: ['consume-options', filename, '{output}/native.json'] });
      const resultFile = path.join(output, 'options-native-continuation/native.json'), bytes = await readFile(resultFile), native = JSON.parse(bytes);
      await writeFile(path.join(output, 'options-continuation-receipt.json'), json({ input: await describeFile(filename), record,
        observation: await describeFile(resultFile), actualNativeInstance: false, phaseAcceptance: false }), { flag: 'wx' });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === resultFile)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(await readFile(filename)));
      for (const flag of ['actualExecution', 'actualXmlSerializer', 'actualCollectionFolderOptions', 'actualReadAndWrite']) assert.equal(native[flag], true);
      assert.equal(native.actualNativeInstance, false); await verifyAssemblies(native, build);
      assert.deepEqual(native.results.map(row => row.name), cases.map(sample => sample.name));
      return native;
    };
    return { native: natives[0], repeat: natives[1], output, candidateRoot, candidates, projections: projections[0], recordCandidate, continueOptions };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
