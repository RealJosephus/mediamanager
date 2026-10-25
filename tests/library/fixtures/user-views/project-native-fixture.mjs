import { validationFileUrl } from '../../../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Development-only projection. Never copies accounts, password hashes or tokens.
// Pass the preserved native-run-v4 directory; ordinary tests use the projection.
const source = path.resolve(process.argv[2]);
const destination = validationFileUrl('./', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const names = ['summary.json', 'stages.json', 'case-stages.json', 'native-http.json', 'server-configuration.json', 'actors.json'];
const sourceFiles = {}, original = {};
for (const name of [...names, 'input.json', 'record-native.mjs', 'initial.db']) {
  const bytes = await readFile(path.join(source, name));
  sourceFiles[name] = { sha256: sha256(bytes), bytes: bytes.length };
  if (names.includes(name)) {
    original[name] = JSON.parse(bytes);
    sourceFiles[name].semanticSha256 = sha256(JSON.stringify(original[name]));
  }
}
assert.equal(original['summary.json'].fixtureSha256, sourceFiles['input.json'].sha256);
assert.equal(original['summary.json'].recorderSha256, sourceFiles['record-native.mjs'].sha256);
const forbidden = new Set(['Password', 'PasswordHash', 'AccessToken', 'ApiKey', 'AuthenticationInfos', 'Users', 'Permissions', 'Preferences']);
function checkSecrets(value) {
  if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    assert.ok(!forbidden.has(key), `Authentication material is excluded: ${key}`);
    checkSecrets(entry);
  }
}
checkSecrets(original);
// Intern whole rows and snapshots without dropping or normalizing any value.
const rows = {}, rowIndexes = {}, states = [], stateIndexes = new Map();
function internState(state) {
  const database = Object.fromEntries(Object.entries(state.database).map(([table, entries]) => {
    rows[table] ??= []; rowIndexes[table] ??= new Map();
    return [table, entries.map(row => {
      const key = JSON.stringify(row), existing = rowIndexes[table].get(key);
      if (existing !== undefined) return existing;
      const index = rows[table].length; rows[table].push(row); rowIndexes[table].set(key, index); return index;
    })];
  }));
  const encoded = { database, filesystem: state.filesystem }, key = JSON.stringify(encoded);
  if (stateIndexes.has(key)) return stateIndexes.get(key);
  const index = states.length; states.push(encoded); stateIndexes.set(key, index); return index;
}
const projection = { schemaVersion: 1, rows, states,
  stages: Object.fromEntries(Object.entries(original['stages.json']).map(([key, state]) => [key, state?.database ? { state: internState(state) } : { value: state }])),
  caseStages: original['case-stages.json'].map(stage => ({ ...stage, before: internState(stage.before), after: internState(stage.after) })),
  http: original['native-http.json'], configuration: original['server-configuration.json'], actors: original['actors.json'],
  summary: original['summary.json'] };
const expanded = states.map(state => ({ database: Object.fromEntries(Object.entries(state.database)
  .map(([table, indexes]) => [table, indexes.map(index => rows[table][index])])), filesystem: state.filesystem }));
assert.deepEqual(Object.fromEntries(Object.entries(projection.stages).map(([key, entry]) => [key, entry.state === undefined ? entry.value : expanded[entry.state]])), original['stages.json']);
assert.deepEqual(projection.caseStages.map(stage => ({ ...stage, before: expanded[stage.before], after: expanded[stage.after] })), original['case-stages.json']);
for (const state of expanded) for (const domain of Object.values(state.filesystem)) {
  assert.ok(domain.entries.every(entry => entry.type === 'directory'), 'This fixture has no initial or generated file payloads.');
}
const bytes = gzipSync(JSON.stringify(projection), { level: 9 });
await writeFile(validationFileUrl('native-contract.json.gz', destination), bytes, { flag: 'wx' });
await writeFile(validationFileUrl('native-manifest.json', destination), JSON.stringify({ schemaVersion: 1,
  source: '.test-input/evidence/user-views-native-v1/native-run-v4', referenceRoot: path.join(source, 'reference'),
  sourceFiles, projection: { file: 'native-contract.json.gz', sha256: sha256(bytes), bytes: bytes.length },
  coverage: { httpResponses: 108, endpointSnapshots: 108, initialItems: 47, finalItems: 64 },
  seed: 'All 13 initial media tables and four empty/directory-only filesystem domains are reconstructed from complete native before observations. Accounts are created with fresh synthetic passwords and native actor IDs; original authentication rows are excluded.'
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, states: states.length, distinctRows: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length])) }));
