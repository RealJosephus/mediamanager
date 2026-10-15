import { validationPath } from '../validation/paths.js';
// Preserve old frozen BoxSet observations as portable test inputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bindings = [];
for (const [name, run, count] of [['legacy-boxset', 'native-run', 185],
  ['boxset-collapse', 'native-run-v2', 320], ['boxset-dispatch', 'native-run-v2', 158]]) {
  const directory = `.agent-docs/evidence/${name}-native-v1/${run}`;
  const read = async file => {
    const bytes = await readFile(validationPath(path.join(repo, directory, file)));
    return { bytes, value: JSON.parse(bytes) };
  };
  // The older collapse recorder did not copy input.json. Its summary binds the
  // tracked input bytes by SHA; the other two recorders retained an exact copy.
  const inputPath = name === 'boxset-collapse' ? `tests/library/fixtures/${name}/input.json` : `${directory}/input.json`;
  const inputBytes = await readFile(validationPath(path.join(repo, inputPath)));
  const input = { bytes: inputBytes, value: JSON.parse(inputBytes) };
  const http = await read('native-http.json'), stages = await read('stages.json'), summary = await read('summary.json');
  assert.equal(summary.value.passed, true);
  assert.equal(summary.value.cases, count);
  assert.equal(summary.value.fixtureSha256, sha256(input.bytes));
  assert.deepEqual(summary.value.processResult, { code: 0, signal: null });
  assert.equal(summary.value.portAvailable, true);
  assert.equal(http.value.records.length, count);
  assert.deepEqual(stages.value.before, stages.value.afterReads);
  assert.deepEqual(stages.value.before, stages.value.afterShutdown);
  assert.deepEqual(stages.value.before.database.foreignKeyCheck, []);
  const trackedInput = await readFile(validationPath(path.join(repo, `tests/library/fixtures/${name}/input.json`)));
  assert.deepEqual(JSON.parse(trackedInput), input.value);
  const sourceBindings = [];
  sourceBindings.push({ path: inputPath, bytes: inputBytes.length, sha256: sha256(inputBytes) });
  for (const file of ['native-http.json', 'stages.json', 'summary.json', '../record-native.mjs',
    'reference-stdout.log', 'reference-stderr.log']) {
    const bytes = await readFile(validationPath(path.join(repo, directory, file)));
    sourceBindings.push({ path: path.posix.normalize(`${directory}/${file}`), bytes: bytes.length, sha256: sha256(bytes) });
  }
  assert.equal(sourceBindings.find(file => file.path.endsWith('/record-native.mjs')).sha256, summary.value.recorderSha256);
  const contract = { format: 1, frozenJellyfin: true, phaseAcceptance: false, sourceBindings,
    trackedInputSha256: sha256(trackedInput), recordedFixtureText: input.bytes.toString('utf8'),
    projection: 'Preserve every complete HTTP record, original native input bytes as UTF-8 text, all recorded seed columns and all three recorded state windows. No credential, session or authentication setup data is projected. Native snapshot coverage remains limited to its original recorded tables/domains.',
    http: http.value, stages: stages.value, summary: summary.value };
  const forbidden = /^(?:Password|PasswordHash|AccessToken|Authorization|AuthenticationProviderId|SessionId|AuthenticationToken)$/iu;
  function check(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `${name}: forbidden credential key ${key}`);
      check(entry);
    }
  }
  check(contract);
  const bytes = JSON.stringify(contract) + '\n';
  assert.equal(bytes.includes('api_key='), false);
  const output = `tests/library/fixtures/${name}/native.json`;
  if (existsSync(validationPath(path.join(repo, output)))) assert.equal(await readFile(validationPath(path.join(repo, output)), 'utf8'), bytes);
  else await writeFile(validationPath(path.join(repo, output)), bytes, { flag: 'wx' });
  bindings.push({ name, output, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes),
    sourceBindings, httpResponses: count, nativeTableNames: Object.keys(stages.value.before.database),
    nativeFilesystemDomains: Object.keys(stages.value.before.filesystem ?? {}) });
}
const result = { phaseAcceptance: false, projectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))), bindings };
await writeFile(validationPath(path.join(repo, '.agent-docs/evidence/boxset-display-order-expansion-v1/portable-legacy-projections.json')),
  JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
