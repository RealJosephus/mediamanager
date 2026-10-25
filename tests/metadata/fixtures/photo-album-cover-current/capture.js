import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll'];
export const fixtureRoot = new URL('./', import.meta.url);
export const inputFile = new URL('input.json', fixtureRoot);
export const inputBytes = await readFile(inputFile);
export const cases = JSON.parse(inputBytes);
export const profile = JSON.parse(await readFile(new URL('current-profile.json', fixtureRoot)));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function nativeProjection(sample) {
  const project = value => typeof value === 'string'
    ? value.replaceAll(sample.root, '$STATE').replaceAll(sample.root.replaceAll('\\', '/'), '$STATE').replaceAll('\\', '/')
    : Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)])) : value;
  const { root, errorStack, errorType, changeError, ...result } = sample;
  return project({ ...result, error: Boolean(errorType), changeFailed: Boolean(changeError) });
}

let pending;
export function captureCurrentNative() {
  return pending ??= capture();
}

async function capture() {
  const output = path.join(validationOutputRoot(), 'photo-album-cover-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, inputSha256: hash(inputBytes), scope: profile.scope,
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    assert.equal(cases.length, profile.cases);
    assert.equal(new Set(cases).size, cases.length);
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, fixtureRoot)));
      assert.equal(actual.sha256, entry.sha256, entry.filename);
      assert.equal(actual.bytes, entry.bytes, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relativePath);
      assert.ok(pinned, 'The designated source offer must include ' + relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pinned.sha256, relativePath);
      report.sourceBindings.push({ relativePath, source });
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/metadata/fixtures/photo-album-cover-current/Oracle.csproj', output: directory,
        args: ['{output}/instance', fileURLToPath(inputFile),
          fileURLToPath(new URL('../../../images/fixtures/http/poster.png', fixtureRoot)),
          fileURLToPath(new URL('../../../images/fixtures/http/backdrop.jpg', fixtureRoot)), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.sourceInputSha256, hash(inputBytes));
      assert.deepEqual(native.results.map(row => row.name), cases);
      for (const key of ['actualProvider', 'actualNativeRepository', 'actualSqlite', 'actualProviderManagerFileSave', 'actualImageSaver'])
        assert.equal(native[key], true, key);
      for (const name of ['Emby.Server.Implementations', 'MediaBrowser.Controller', 'MediaBrowser.Providers',
        'Jellyfin.Server.Implementations', 'Jellyfin.Database.Implementations']) {
        const assembly = native.assemblies.find(entry => entry.name === name);
        assert.ok(assembly, name + ' was loaded by the actual provider');
        assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
      }
      for (const assembly of native.assemblies) {
        const pinned = build.manifest.files.find(entry => entry.path === assembly.name + '.dll');
        if (pinned) assert.equal(assembly.sha256, pinned.sha256, assembly.name);
      }
      const sqlitePath = 'runtimes/' + native.sqlite.rid + '/native/' + path.basename(native.sqlite.filename);
      const sqlite = build.manifest.files.find(entry => entry.path === sqlitePath);
      assert.ok(sqlite, 'SQLite must come from the supplied runtime and exact SDK RID');
      assert.equal(native.sqlite.sha256, sqlite.sha256, sqlitePath);
      if (first) assert.deepEqual(native.results.map(nativeProjection), first.results.map(nativeProjection), 'Independent native captures');
      else first = native;
    }
    report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, output, report };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(name, observation) {
  const { output } = await captureCurrentNative();
  assert.match(name, /^[a-z0-9-]+$/u);
  await writeFile(path.join(output, 'candidate', name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
}
