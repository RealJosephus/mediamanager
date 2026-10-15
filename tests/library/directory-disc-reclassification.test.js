import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/directory-disc-reclassification/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
const paritySamples = input.slice(0, 9);
const promotionSamples = input.filter((_, index) => [9, 11, 12].includes(index));
const folderSamples = input.filter(sample => sample.recursiveValidation === true);

test('directory disc reclassification actual oracle, lifecycle prefixes and phase boundary are sealed', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(provenance.candidateVerified, true);
  assert.equal(native.actualFrozenDirectoryDiscReclassification, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(input.length, 18);
  assert.equal(paritySamples.length, 9);
  assert.equal(promotionSamples.length, 3);
  assert.equal(folderSamples.length, 5);
  const historicalProjection = native.results.slice(0, 11)
    .map(({ userData, migrationSeed, recursiveIdentityKeys, ...historical }) => historical);
  assert.equal(createHash('sha256').update(stringifyNativeJson(historicalProjection)).digest('hex'),
    provenance.record.previous11ResultsProjectionSha256);
  const previousResults = native.results.slice(0, 13)
    .map(({ recursiveIdentityKeys, ...historical }) => historical);
  assert.equal(createHash('sha256').update(stringifyNativeJson(previousResults)).digest('hex'),
    provenance.record.previous13ResultsSha256);
  for (const result of native.results.slice(0, 13)) {
    assert.equal(result.recursiveIdentityKeys, null);
  }
  for (const result of native.results.slice(0, 11)) {
    assert.deepEqual(result.userData, []);
    assert.equal(result.migrationSeed, null);
  }
  assert.deepEqual(provenance.candidateComparison.parityScenarios, paritySamples.map(sample => sample.name));
  assert.deepEqual(provenance.candidateComparison.promotionScenarios, promotionSamples.map(sample => sample.name));
  assert.deepEqual(provenance.candidateComparison.folderScenarios, folderSamples.map(sample => sample.name));
  assert.ok(paritySamples.some(sample => sample.failSaver));
  assert.ok(paritySamples.some(sample => sample.failUpdate));
  assert.ok(paritySamples.some(sample => sample.cancelFromSaver));
  assert.ok(paritySamples.some(sample => sample.failEvent));
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) {
    assert.ok(result.beforeItem);
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
  const folderActions = name => native.results.find(result => result.name === name).calls
    .filter(call => ['delete', 'event', 'save', 'reattach'].includes(call.action))
    .map(call => call.action === 'event' ? `${call.action}:${call.kind}` : call.action);
  assert.deepEqual(folderActions('dvd-two-to-folder-control'),
    ['delete', 'event:removed', 'save', 'event:added']);
  assert.deepEqual(folderActions('dvd-two-to-folder-recursive'),
    ['delete', 'event:removed', 'save', 'event:added', 'save', 'event:added']);
  assert.deepEqual(folderActions('dvd-two-to-folder-recursive-shared-user-data'),
    ['delete', 'event:removed', 'save', 'event:added', 'save', 'event:added']);
  assert.deepEqual(folderActions('dvd-two-to-folder-outer-create-failure'),
    ['delete', 'event:removed', 'save']);
  assert.deepEqual(folderActions('dvd-two-to-folder-nested-create-failure'),
    ['delete', 'event:removed', 'save', 'event:added', 'save']);
  assert.deepEqual(folderActions('dvd-two-to-folder-cancel-after-outer-added'),
    ['delete', 'event:removed', 'save', 'event:added']);
  for (const sample of folderSamples) {
    const result = native.results.find(value => value.name === sample.name);
    assert.notEqual(result.beforeItem.id, result.rows.find(row => row.path === '$STATE\\media\\Film')?.id);
    assert.ok(Array.isArray(result.recursiveIdentityKeys));
  }
  for (const sample of promotionSamples) {
    const result = native.results.find(value => value.name === sample.name);
    assert.notEqual(result.beforeItem.id, result.rows.find(row => row.type === sample.expectedType
      || row.type.endsWith(`.${sample.expectedType}`))?.id);
    assert.deepEqual(result.calls.filter(call => ['delete', 'event', 'save', 'reattach'].includes(call.action))
      .map(call => call.action === 'event' ? `${call.action}:${call.kind}` : call.action),
    sample.migrationEvidence
      ? ['delete', 'event:removed', 'save', 'event:added', 'reattach']
      : ['delete', 'event:removed', 'save', 'event:added']);
  }
  const migration = native.results.find(result => result.name === 'dvd-primary-remove-three-to-two-migration');
  assert.deepEqual(migration.links, []);
  assert.equal(migration.providers.length, 1);
  assert.equal(migration.providers[0].providerValue, migration.migrationSeed.sharedKey);
  const identityData = migration.userData.find(row => row.customDataKey === migration.migrationSeed.identityKey);
  const sharedData = migration.userData.find(row => row.customDataKey === migration.migrationSeed.sharedKey);
  assert.equal(identityData.itemId, '00000000-0000-0000-0000-000000000001');
  assert.equal(identityData.retentionDate, '$UTC_DELETE');
  assert.notEqual(sharedData.itemId, migration.migrationSeed.oldId);
  assert.equal(sharedData.retentionDate, null);
  assert.equal(sharedData.playCount, 7);
  assert.equal(sharedData.playbackPositionTicks, 9007199254740993n);
  const recursiveMigration = native.results.find(result =>
    result.name === 'dvd-two-to-folder-recursive-shared-user-data');
  assert.equal(recursiveMigration.calls.some(call => call.action === 'reattach'), false);
  assert.equal(recursiveMigration.providers.length, 1);
  const nestedKeys = recursiveMigration.recursiveIdentityKeys.find(item =>
    item.type === 'MediaBrowser.Controller.Entities.Movies.Movie').keys;
  assert.ok(nestedKeys.includes(recursiveMigration.migrationSeed.sharedKey));
  for (const row of recursiveMigration.userData) {
    assert.equal(row.itemId, '00000000-0000-0000-0000-000000000001');
    assert.equal(row.retentionDate, '$UTC_DELETE');
  }
});

for (const dialect of ['postgres']) for (const sample of paritySamples) test(
  `${dialect}: native same-identity directory disc lifecycle ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES },
  async t => {
    const { userData, migrationSeed, recursiveIdentityKeys, ...historicalContract } = native.results
      .find(result => result.name === sample.name);
    await assertDirectoryValidation(t, dialect, sample, historicalContract, { reconciliation: true });
  });
