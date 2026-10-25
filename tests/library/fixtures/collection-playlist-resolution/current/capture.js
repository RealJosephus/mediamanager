import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../../../../src/core/json.js';
import { newNativeItemEntity } from '../../../../../src/library/native-item-entity.js';
import { StorageError } from '../../../../../src/storage/errors.js';
import { verifyNativeBuild } from '../../../../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../../../../tools/validation/inventory.js';
import { recordOracle } from '../../../../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../../tools/validation/paths.js';
import { parentId, created, modified } from '../../../collection-playlist-runtime-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const fixtureRoot = new URL('../', import.meta.url);
const inputFile = new URL('./input.json', import.meta.url);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const profile = JSON.parse(await readFile(new URL('../current-profile.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const neutralFile = Buffer.from('neutral fixture file');

export function expectedMediaTree(sample) {
  const entries = new Map();
  const add = (relative, kind) => {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) entries.set(parts.slice(0, index).join('/'), 'directory');
    entries.set(relative, kind);
  };
  for (const relative of sample.directories ?? []) add(relative, 'directory');
  for (const relative of sample.files ?? []) add(relative, 'file');
  return [...entries].sort(([left], [right]) => ordinal(left, right)).map(([relative, kind]) => ({
    path: relative, kind, bytes: kind === 'file' ? neutralFile.length : null,
    sha256: kind === 'file' ? hash(neutralFile) : null,
  }));
}

export async function mediaTree(sampleRoot) {
  const root = path.join(sampleRoot, 'media'), entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
      assert.ok(entry.isFile() || entry.isDirectory(), 'The neutral filesystem must contain ordinary files and directories.');
      const bytes = entry.isFile() ? await readFile(filename) : null;
      entries.push({ path: relative, kind: entry.isFile() ? 'file' : 'directory',
        bytes: bytes?.length ?? null, sha256: bytes == null ? null : hash(bytes) });
      if (entry.isDirectory()) await walk(filename);
    }
  }
  await walk(root);
  return entries.sort((left, right) => ordinal(left.path, right.path));
}

// Node observes the same real neutral files as Native. Only IDs, timestamp
// inputs and virtual path reversal are controlled by the component fixture.
export async function currentSampleContext(sample, sampleRoot) {
  const media = path.join(sampleRoot, 'media');
  const candidateFor = async filename => {
    const info = await lstat(filename, { bigint: true });
    assert.ok(info.isFile() || info.isDirectory(), sample.name + ': ordinary neutral entry');
    return { identityPath: filename, accessPath: '/fixture/collection-resolver/' + sample.name + '/'
      + path.relative(media, filename).split(path.sep).join('/'),
    entry: { name: path.basename(filename), kind: info.isDirectory() ? 'directory' : 'file',
      size: info.isFile() ? info.size : null, created, modified } };
  };
  const target = await candidateFor(path.join(media, ...sample.target.split('/')));
  if (sample.trailingSeparator) target.identityPath += path.sep;
  if (sample.enumerationError) target.identityPath = path.join(media, 'absent-native-directory');
  const parent = newNativeItemEntity(sample.parentKind === 'PlaylistsFolder'
    ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder' : 'MediaBrowser.Controller.Entities.Folder');
  Object.assign(parent, { Id: parentId, Name: 'Physical root', Path: media });
  return { parent, candidate: target, collectionContext: { collectionType: sample.collectionType ?? null }, deletionSafe: true,
    peekDirectory: async () => {
      try {
        const entries = await readdir(target.identityPath);
        return { listing: { deletionSafe: true },
          candidates: await Promise.all(entries.map(name => candidateFor(path.join(target.identityPath, name)))) };
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new StorageError(
          error.code === 'ENOENT' ? 'not-found' : 'not-directory', 'The neutral directory is unavailable.', { cause: error });
        throw error;
      }
    } };
}

let pending;
export function captureCurrentNative() { return pending ??= capture(); }

async function capture() {
  const output = path.join(validationOutputRoot(), 'collection-playlist-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: hash(inputBytes), inputs: [], sourceBindings: [],
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, fixtureRoot)));
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
    const directory = path.join(output, 'native');
    const record = await recordOracle({ project: 'tests/library/fixtures/collection-playlist-resolution/current/Oracle.csproj',
      output: directory, args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/state'] });
    const filename = path.join(directory, 'native.json'), bytes = await readFile(filename);
    const native = parseLosslessJson(bytes.toString('utf8'));
    report.capture = { record, observation: await describeFile(filename) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(inputBytes));
    for (const assembly of native.assemblies) {
      const bound = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(bound.available, true, assembly.name);
      assert.equal(bound.sha256, assembly.sha256, assembly.name);
    }
    const sqlite = await describeFile(path.join(build.runtime, 'runtimes', native.nativeSqlite.runtimeIdentifier,
      'native', native.nativeSqlite.name));
    assert.equal(sqlite.available, true); assert.equal(sqlite.sha256, native.nativeSqlite.sha256);
    assert.equal(native.nativeSqlite.resolverObserved, true);
    assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
    for (const [index, sample] of input.entries()) {
      const result = native.results[index];
      assert.deepEqual(result.filesBefore, expectedMediaTree(sample), sample.name + ': neutral Native filesystem');
      assert.deepEqual(result.filesAfter, result.filesBefore, sample.name + ': Native leaves media unchanged');
    }
    report.nativeExecutionRecorded = true;
    await mkdir(path.join(output, 'candidate'));
    return { native, output, stateRoot: path.join(directory, 'state'), report };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(stage, observation) {
  const { output } = await captureCurrentNative();
  assert.match(stage, /^[a-zA-Z0-9_.-]+$/u);
  assert.match(observation.name, /^[a-zA-Z0-9_.-]+$/u);
  const directory = path.join(output, 'candidate', stage);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, observation.name + '.json'), JSON.stringify(observation,
    (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
}
