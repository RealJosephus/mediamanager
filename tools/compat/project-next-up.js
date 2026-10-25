// Verify frozen NextUp evidence before projecting a self-contained test fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node tools/compat/project-next-up.js <native-evidence-directory> <new-fixture-file>');
const source = path.resolve(sourceArgument);
const names = ['input.json', 'record-next-up.js', 'native-http.json', 'stages.json', 'case-stages.json',
  'summary.json', 'reference-stdout.log', 'reference-stderr.log'];
const bytes = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(source, name))])));
const parse = name => JSON.parse(bytes[name]);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const input = parse('input.json'), http = parse('native-http.json'), stages = parse('stages.json');
const caseStages = parse('case-stages.json'), summary = parse('summary.json');
assert.equal(summary.passed, true);
assert.equal(summary.candidateVerified, false);
assert.equal(summary.phaseAcceptance, false);
assert.equal(summary.fixtureSha256, hash(bytes['input.json']));
assert.equal(summary.recorderSha256, hash(bytes['record-next-up.js']));
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(summary.cases, http.records.length);
assert.equal(summary.snapshots, caseStages.length);
assert.equal(summary.cases, input.cases.reduce((count, item) => count + (item.endpoints?.length ?? 2), 0));
assert.deepEqual(stages.before, stages.afterReads);
assert.deepEqual(stages.afterReads, stages.afterShutdown);
for (const [index, stage] of caseStages.entries()) {
  assert.deepEqual([stage.name, stage.endpoint], [http.records[index].name, http.records[index].endpoint]);
  assert.deepEqual(stage.before, stage.after);
  assert.deepEqual(stage.before, stages.before);
  assert.equal(http.records[index].response.status, input.cases.find(item => item.name === stage.name).expectedStatus ?? 200);
}
const log = bytes['reference-stdout.log'].toString('utf8');
const errors = [...log.matchAll(/ArgumentNullException: Value cannot be null\. \(Parameter 'filter\.User'\)/gu)];
assert.equal(errors.length, http.records.filter(record => record.response.status === 400).length);
assert.equal(bytes['reference-stderr.log'].length, 0);
await writeFile(path.resolve(outputArgument), JSON.stringify({ schemaVersion: 1,
  source: { directory: path.relative(process.cwd(), source).replaceAll('\\', '/'),
    files: Object.fromEntries(names.map(name => [name, { bytes: bytes[name].length, sha256: hash(bytes[name]) }])),
    projection: 'Complete original HTTP records and initial native BaseItems; full endpoint and shutdown snapshots are verified without normalization and bound by SHA256.' },
  summary, http, initialBaseItems: stages.before.database.baseItems,
  immutableState: { readStages: ['before', 'afterReads', 'afterShutdown'].map(name => ({ name, sha256: digest(stages[name]) })),
    caseStages: caseStages.map(stage => ({ name: stage.name, endpoint: stage.endpoint,
      beforeSha256: digest(stage.before), afterSha256: digest(stage.after) })) },
  nativeErrors: { type: 'ArgumentNullException', parameter: 'filter.User', count: errors.length },
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ source: path.relative(process.cwd(), source), output: outputArgument,
  responses: summary.cases, snapshots: summary.snapshots, passed: true, phaseAcceptance: false }));
