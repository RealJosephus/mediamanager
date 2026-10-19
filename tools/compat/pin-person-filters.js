import { validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceEvidence = '.agent-docs/evidence/person-sortname-memory-default-frozen-v1';
const source = validationPath(path.join(repo, sourceEvidence));
const inputPath = validationPath(path.join(repo, 'tests/library/fixtures/person-filters/input.json'));
const target = validationPath(path.join(repo, 'tests/library/fixtures/person-filters/native.json'));
const inputBytes = await readFile(inputPath);
const input = JSON.parse(inputBytes);
const raw = JSON.parse(await readFile(path.join(source, 'native-contract.json'), 'utf8'));
const summary = JSON.parse(await readFile(path.join(source, 'summary.json'), 'utf8'));
assert.equal(summary.passed, true);
assert.deepEqual(summary.discoveryOnlyCases, []);
assert.equal(summary.fixtureCases, input.cases.length);
assert.equal(summary.endpointCases, input.cases.reduce((count, item) => count + (item.endpoints?.length ?? 2), 0));
assert.equal(summary.databaseUnchangedByReads, true);
assert.equal(summary.process.cleanShutdown, true);
assert.equal(summary.process.code, 0);
assert.equal(summary.process.portFinallyAvailable, true);
assert.equal(raw.fixtureInputSha256, createHash('sha256').update(inputBytes).digest('hex'));
assert.equal(raw.cases.length, input.cases.length);

const cases = raw.cases.map((entry, index) => {
  const sourceCase = input.cases[index];
  assert.equal(entry.name, sourceCase.name);
  assert.equal(entry.query, sourceCase.query);
  assert.deepEqual(entry.scope, sourceCase.scope);
  const contract = Object.fromEntries([
    'name', 'query', 'scope', 'auth', 'endpoints', 'status', 'contentType',
    'totalRecordCount', 'ids', 'keys', 'problem',
  ].map(key => [key, entry[key]]));
  if (entry.name.startsWith('person-sortname-')) {
    if (sourceCase.parentKey) contract.parentKey = sourceCase.parentKey;
    if (sourceCase.omitIds) contract.omitIds = true;
    if (Object.hasOwn(sourceCase, 'recursive')) contract.recursive = sourceCase.recursive;
    if (sourceCase.sortBy) contract.sortBy = sourceCase.sortBy;
    if (sourceCase.omitSortBy) contract.omitSortBy = true;
    contract.fields = sourceCase.fields;
    contract.orderedKeys = entry.items.map(item => item.key);
    contract.sortNames = entry.items.map(item => ({ key: item.key, value: item.sortName }));
    if (entry.errorText !== undefined) contract.errorText = entry.errorText;
  }
  return contract;
});

const frozen = {
  schemaVersion: 1,
  frozenJellyfin: true,
  sourceEvidence: `${sourceEvidence}/native-contract.json`,
  fixtureInputSha256: raw.fixtureInputSha256,
  endpoints: raw.endpoints,
  cases,
};
await writeFile(target, JSON.stringify(frozen) + '\n');
console.log(JSON.stringify({ cases: cases.length, endpoints: summary.endpointCases,
  sortCases: cases.filter(item => item.name.startsWith('person-sortname-')).length }));
