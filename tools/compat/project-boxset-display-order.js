import { validationPath } from '../validation/paths.js';
// Mechanically preserve the isolated frozen BoxSet sorting recording.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = '.test-input/evidence/boxset-display-order-expansion-v1/native-run';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async name => { const bytes = await readFile(validationPath(path.join(repo, directory, name))); return { bytes, value: JSON.parse(bytes) }; };
const input = await load('input.json'), http = await load('native-http.json'), stages = await load('stages.json'), summary = await load('summary.json');
assert.equal(summary.value.passed, true);
assert.equal(summary.value.cases, 169);
assert.equal(summary.value.fixtureSha256, sha256(input.bytes));
assert.deepEqual(summary.value.processResult, { code: 0, signal: null });
assert.equal(summary.value.portAvailable, true);
assert.deepEqual(stages.value.before, stages.value.afterReads);
assert.deepEqual(stages.value.before, stages.value.afterShutdown);
assert.deepEqual(stages.value.before.database.foreignKeyCheck, []);
assert.equal(stages.value.before.database.userData.length, 91);
assert.equal(http.value.records.length, 169);
assert.ok(http.value.records.every(row => row.response.status === 200));
const sourceBindings = [];
for (const name of ['input.json', 'native-http.json', 'stages.json', 'summary.json', '../record-native.mjs', 'reference-stdout.log', 'reference-stderr.log']) {
  const bytes = await readFile(validationPath(path.join(repo, directory, name)));
  sourceBindings.push({ path: path.posix.normalize(directory + '/' + name), bytes: bytes.length, sha256: sha256(bytes) });
}
assert.equal(sourceBindings.find(row => row.path.endsWith('/record-native.mjs')).sha256, summary.value.recorderSha256);
const contract = { format: 1, frozenJellyfin: true, phaseAcceptance: false, fixtureInputSha256: sha256(input.bytes), sourceBindings,
  projection: 'Preserve every complete HTTP record and every native target BaseItem seed column. Verify recorded target tables, UserData and four filesystem domains are identical before reads, after reads and after shutdown; store their table/domain names and counts. No authentication setup, credential/session table or raw token is included. Native per-endpoint state was not recorded.',
  summary: summary.value, seedBaseItems: stages.value.before.database.baseItems, http: http.value,
  nativeStateInvariant: { beforeEqualsAfterReadsEqualsAfterShutdown: true,
    tableCounts: Object.fromEntries(Object.entries(stages.value.before.database).map(([name, rows]) => [name, rows.length])),
    filesystemDomains: Object.keys(stages.value.before.filesystem) } };
const output = 'tests/library/fixtures/boxset-display-order/native.json';
const fixtureBytes = JSON.stringify(contract) + '\n';
await writeFile(validationPath(path.join(repo, output)), fixtureBytes, { flag: 'wx' });
const binding = { output, bytes: Buffer.byteLength(fixtureBytes), sha256: sha256(fixtureBytes), inputSha256: sha256(input.bytes),
  projectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))), responses: 169, seedRows: contract.seedBaseItems.length };
await writeFile(validationPath(path.join(repo, directory, 'fixture-projection.json')), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(binding));
