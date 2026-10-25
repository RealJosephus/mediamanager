import { validationPath } from '../validation/paths.js';
// Preserve the separately recorded null-user HTTP errors without rewriting its raw summary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = '.test-input/evidence/boxset-null-user-query-native-v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => { const bytes = await readFile(validationPath(path.join(repo, directory, name))); return { bytes, value: JSON.parse(bytes) }; };
const input = await read('input.json'), http = await read('native-run/native-http.json'), stages = await read('native-run/stages.json'),
  summary = await read('native-run/summary.json'), audit = await read('native-observation-audit.json');
assert.equal(audit.value.passed, true);
assert.equal(summary.value.passed, false);
assert.equal(summary.value.error, null);
assert.equal(summary.value.fixtureSha256, sha256(input.bytes));
assert.equal(summary.value.portAvailable, true);
assert.deepEqual(summary.value.processResult, { code: 0, signal: null });
assert.equal(http.value.records.length, 14);
assert.deepEqual(stages.value.before, stages.value.afterReads);
assert.deepEqual(stages.value.before, stages.value.afterShutdown);
const diagnostics = (await readFile(validationPath(path.join(repo, directory, 'native-run/reference-stdout.log')), 'utf8'))
  .match(/System.ArgumentException: Sort key '[^']+' requires a user, but none was provided\./gu);
assert.equal(diagnostics.length, 8);
const sourceBindings = [];
for (const name of ['input.json', 'record-native.mjs', 'native-run/native-http.json', 'native-run/stages.json',
  'native-run/summary.json', 'native-run/reference-stdout.log', 'native-run/reference-stderr.log', 'native-observation-audit.json']) {
  const bytes = await readFile(validationPath(path.join(repo, directory, name)));
  sourceBindings.push({ path: `${directory}/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
}
assert.equal(sourceBindings.find(row => row.path.endsWith('/record-native.mjs')).sha256, summary.value.recorderSha256);
const contract = { format: 1, frozenJellyfin: true, phaseAcceptance: false, fixtureInputSha256: sha256(input.bytes),
  sourceBindings, summary: summary.value, audit: audit.value, diagnostics, seedBaseItems: stages.value.before.database.baseItems,
  http: http.value, nativeStateInvariant: { beforeEqualsAfterReadsEqualsAfterShutdown: true,
    tableCounts: Object.fromEntries(Object.entries(stages.value.before.database).map(([key, rows]) => [key, rows.length])),
    filesystemDomains: Object.keys(stages.value.before.filesystem) },
  scope: '14 complete native HTTP observations plus complete target BaseItem seed columns; original raw summary remains false because inherited recorder excludes400. Separate source/DLL-backed audit verifies eight expected400 errors, normal200 controls, three unchanged native state windows and server shutdown. No native per-endpoint or complete-database coverage is claimed; no credential/authentication setup is included.' };
const nativeOutput = 'tests/library/fixtures/boxset-display-order/null-user-native.json';
const inputOutput = 'tests/library/fixtures/boxset-display-order/null-user-input.json';
await copyFile(validationPath(path.join(repo, directory, 'input.json')), validationPath(path.join(repo, inputOutput)), 1);
const bytes = JSON.stringify(contract) + '\n';
assert.equal(bytes.includes('api_key='), false);
await writeFile(validationPath(path.join(repo, nativeOutput)), bytes, { flag: 'wx' });
const binding = { phaseAcceptance: false, output: nativeOutput, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes),
  inputOutput, inputSha256: sha256(input.bytes), projectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
await writeFile(validationPath(path.join(repo, directory, 'fixture-projection.json')), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(binding));
