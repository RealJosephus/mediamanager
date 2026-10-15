import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-validation-progress/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const read = async url => parseLosslessJson(await readFile(url, 'utf8'));
const [input, native, provenance, record] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'record.json']
  .map(name => read(new URL(name, root))));
const [directoryInput, directoryNative, reconciliationInput, reconciliationNative] = await Promise.all([
  'directory-native-validation/input.json', 'directory-native-validation/native.json',
  'folder-child-reconciliation/input.json', 'folder-child-reconciliation/native.json'
].map(name => read(new URL('./fixtures/' + name, import.meta.url))));
const nativeProgress = name => native.results.find(sample => sample.name === name).progress;
const source = directoryInput.find(sample => sample.name === 'directory-single-file');
const expected = directoryNative.results.find(sample => sample.name === source.name);

test('folder progress recording binds the actual native assembly, source and nineteen phase boundaries', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  for (const file of provenance.referenceSources) assert.equal(createHash('sha256')
    .update(await readFile(file.path)).digest('hex'), file.sha256, file.path);
  for (const file of record.sourceFiles) assert.equal(createHash('sha256')
    .update(await readFile(file.filename)).digest('hex'), file.sha256, file.filename);
  assert.equal(record.passed, true);
  assert.equal(record.build.status, 0);
  assert.equal(record.process.status, 0);
  assert.equal(record.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(native.assembly.sha256, '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8');
  assert.equal(native.inputSha256, provenance.fixtureFiles.find(file => file.path.endsWith('/input.json')).sha256);
  assert.deepEqual(native.results.map(sample => sample.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 19);
  assert.deepEqual(nativeProgress('empty'), [5, 5.5, 6, 7, 8, 9, 10]);
  assert.deepEqual(nativeProgress('twenty-six'), [5, 5.5, 6, 7, 7 + 25 / 26, 8, 8, 9, 10]);
  assert.deepEqual(nativeProgress('enumeration-failure'), [5, 5.5]);
  assert.deepEqual(nativeProgress('creation-failure'), [5, 5.5, 6, 7, 8, 8]);
  assert.deepEqual(nativeProgress('deletion-failure'), [5, 5.5, 6, 7, 8]);
  assert.deepEqual(native.results.find(sample => sample.name === 'recursive-cancel-after-load').providerProgress,
    nativeProgress('cancel-after-load'));
});

const postgres = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
test('postgres: full creation still matches native persistence and reports every early phase', postgres, async t => {
  const progress = [];
  await assertDirectoryValidation(t, 'postgres', source, expected, { reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, nativeProgress('one'));
});

test('postgres: a failed insert retains the native progress prefix and full failure side effects', postgres, async t => {
  const sample = directoryInput.find(sample => sample.name === 'validate-first-insert-fault');
  const progress = [];
  await assertDirectoryValidation(t, 'postgres', sample, directoryNative.results.find(result => result.name === sample.name),
    { reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, nativeProgress('creation-failure'));
});

test('postgres: a failed removal never advertises completed removal or mutation phases', postgres, async t => {
  const sample = reconciliationInput.find(sample => sample.name === 'movie-delete-sql-failure');
  const progress = [];
  await assertDirectoryValidation(t, 'postgres', sample, reconciliationNative.results.find(result => result.name === sample.name),
    { reconciliation: true, reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, nativeProgress('deletion-failure'));
});

for (const cancelAt of [5, 5.5, 6, 7]) test(`postgres: cancellation at ${cancelAt} completes retrieval before updates and clears provider progress`, postgres, async t => {
  const { fixture, validation, loaded } = await assertDirectoryValidation(t, 'postgres', source, expected);
  const before = await fixture.database.rows('BaseItems'), controller = new AbortController();
  const progress = [], providerProgress = [];
  validation.refreshes.on('RefreshProgress', event => providerProgress.push(event.Progress));
  await assert.rejects(validation.validateChildren(loaded.parent, { collectionType: source.collectionType,
    recursive: true, refreshChildMetadata: false, signal: controller.signal,
    reportProgress(value) { progress.push(value); if (value === cancelAt) controller.abort(); }
  }), error => error === controller.signal.reason);
  assert.deepEqual(progress, nativeProgress('recursive-cancel-after-load'));
  assert.deepEqual(providerProgress, native.results.find(sample => sample.name === 'recursive-cancel-after-load').providerProgress);
  assert.equal(validation.refreshes.getRefreshProgress(loaded.parent.Id), null);
  assert.deepEqual(await fixture.database.rows('BaseItems'), before);
});

test('postgres: an enumeration failure returns before observing cancellation raised during retrieval', postgres, async t => {
  const { fixture, validation, loaded } = await assertDirectoryValidation(t, 'postgres', source, expected);
  const before = await fixture.database.rows('BaseItems'), controller = new AbortController(), progress = [];
  const failure = new Error('Controlled directory enumeration failure.');
  validation.resolverPipeline.resolve = async ({ onEnumerationReady }) => {
    onEnumerationReady();
    throw failure;
  };
  const reported = [];
  validation.onError = error => reported.push(error);
  const result = await validation.validateChildren(loaded.parent, { collectionType: source.collectionType,
    recursive: true, refreshChildMetadata: false, signal: controller.signal,
    reportProgress(value) { progress.push(value); if (value === 5) controller.abort(); }
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(progress, nativeProgress('cancel-and-enumeration-failure'));
  assert.deepEqual(reported, [failure]);
  assert.equal(validation.refreshes.getRefreshProgress(loaded.parent.Id), null);
  assert.deepEqual(await fixture.database.rows('BaseItems'), before);
});

test('postgres: early progress advances at the twenty-fifth child before the sibling batch is saved', postgres, async t => {
  const { fixture, validation, loaded } = await assertDirectoryValidation(t, 'postgres', source, expected);
  for (let index = 0; index < 25; index++) await fixture.adapter.write(`/discovery/Feature ${String(index).padStart(2, '0')} (2025).mkv`,
    Buffer.from('media control'), { modified: '2025-01-03T04:05:06.0000000Z' });
  const progress = [], before = await fixture.database.rows('BaseItems');
  let observedBatch = false;
  const createItems = fixture.library.createItems.bind(fixture.library);
  fixture.library.createItems = async (...args) => {
    observedBatch = true;
    assert.equal(args[0].length, 25);
    assert.deepEqual(progress, nativeProgress('twenty-six').slice(0, -2));
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    return createItems(...args);
  };
  await validation.validateChildren(loaded.parent, { collectionType: source.collectionType,
    recursive: false, refreshChildMetadata: false, reportProgress: value => progress.push(value) });
  assert.equal(observedBatch, true);
  assert.deepEqual(progress, nativeProgress('twenty-six'));
  assert.equal((await fixture.database.rows('BaseItems', { where: { ParentId: loaded.parent.Id } })).length, 26);
});
