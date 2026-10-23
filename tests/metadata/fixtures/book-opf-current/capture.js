import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const fixtureRoot = new URL('./', import.meta.url);
export const inputFile = new URL('./input.json', import.meta.url);
export const inputBytes = await readFile(inputFile);
export const manifest = JSON.parse(inputBytes);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.timeZone, 'Asia/Taipei');
assert.equal(manifest.timeZoneOffsetMinutes, 480);
process.env.TZ = manifest.timeZone;
const timeZoneControl = { requested: manifest.timeZone, effective: Intl.DateTimeFormat().resolvedOptions().timeZone,
  instant: manifest.timeZoneInstant, offsetMinutes: 0 - new Date(manifest.timeZoneInstant).getTimezoneOffset() };
assert.equal(timeZoneControl.offsetMinutes, manifest.timeZoneOffsetMinutes);

export const assetUrl = (group, filename) => new URL('assets/' + group + '/' + filename, fixtureRoot);
export async function assetBytes(group, entry) {
  const bytes = await readFile(assetUrl(group, entry.storedPath));
  assert.equal(bytes.length, entry.bytes, entry.storedPath);
  assert.equal(hash(bytes), entry.sha256, entry.storedPath);
  const expanded = entry.compression === 'gzip' ? gunzipSync(bytes) : bytes;
  assert.equal(expanded.length, entry.expandedBytes, entry.path);
  assert.equal(hash(expanded), entry.expandedSha256, entry.path);
  return expanded;
}

// Error classes/messages are CLR diagnostics. Preserve the raw captures while
// comparing failure, complete metadata prefixes, logs and filesystem effects.
export function functionalNative(groups) {
  const metadata = row => ({ ...row, error: Boolean(row.error), logs: row.logs.length });
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, name === 'resources' ? {
    ...group, results: group.results.map(({ message, ...row }) => ({ ...row, error: Boolean(row.error) })),
  } : {
    ...group, readerResults: group.readerResults.map(metadata), providerResults: group.providerResults.map(metadata),
    epubResults: group.epubResults.map(row => ({ ...metadata(row), coverError: Boolean(row.coverError) })),
    archiveResults: group.archiveResults.map(row => ({ ...row,
      queries: row.queries.map(query => ({ ...query, error: Boolean(query.error) })),
    })),
  }]));
}

let pending;
export function captureCurrentNative() {
  return pending ??= capture();
}

async function capture() {
  const output = path.join(validationOutputRoot(), 'book-opf-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, inputSha256: hash(inputBytes), scope: manifest.scope, timeZoneControl,
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of manifest.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relative);
      assert.ok(pinned, 'The designated source offer must include ' + relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    for (const [name, group] of Object.entries(manifest.groups)) {
      assert.equal(new Set(group.assets.map(entry => entry.path)).size, group.assets.length);
      for (const entry of group.assets) await assetBytes(name, entry);
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/metadata/fixtures/book-opf-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/assets', '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(record.timezone, manifest.timeZone);
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(inputBytes));
      for (const key of ['requested', 'instant', 'offsetMinutes']) assert.equal(native.timeZoneControl[key], timeZoneControl[key], key);
      assert.deepEqual(Object.keys(native.groups), Object.keys(manifest.groups));
      assert.equal(native.assemblies.find(entry => entry.name === 'jellyfin')?.sha256, record.jellyfinDll.sha256);
      for (const assembly of native.assemblies) {
        const bound = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(bound.sha256, assembly.sha256, assembly.name);
      }
      for (const [name, group] of Object.entries(manifest.groups)) {
        const observed = native.groups[name];
        assert.deepEqual([...observed.assetFiles].sort((a, b) => a.path.localeCompare(b.path)), group.assets.map(entry => ({
          path: entry.path, bytes: entry.expandedBytes, sha256: entry.expandedSha256,
        })).sort((a, b) => a.path.localeCompare(b.path)), name + ': exact post-execution asset membership and bytes');
        if (name === 'resources') assert.deepEqual(observed.results.map(entry => entry.name), group.input.cases.map(entry => entry.name));
        else for (const [key, cases] of [['readerResults', 'readers'], ['providerResults', 'opf'], ['epubResults', 'epubs'], ['archiveResults', 'archives']])
          assert.deepEqual(observed[key].map(entry => entry.name), group.input[cases].map(entry => entry.name));
      }
      if (first) assert.deepEqual(functionalNative(native.groups), functionalNative(first.groups), 'Independent native captures');
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

export async function recordCandidate(group, category, observation) {
  const { output } = await captureCurrentNative();
  assert.match(observation.name, /^[a-zA-Z0-9_.-]+$/u);
  const directory = path.join(output, 'candidate', group, category);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, observation.name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
}
