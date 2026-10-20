import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { identitySideEffectInput } from '../../tools/compat/identity-side-effect-input.js';
import { recordCurrentIdentities } from '../../tools/compat/record-current-identities.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordItemFilterCandidate } from '../library/item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses } from '../library/full-filter-wire.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const columns = tableDefinition('BaseItems').columns;
const clockColumns = new Set(['DateCreated', 'DateModified']);

export async function currentIdentityScenario(kind, mode, { precondition } = {}) {
  const input = identitySideEffectInput(kind, mode);
  const root = path.join(validationOutputRoot(), `identity-${kind}-${mode}-${randomUUID()}`);
  await recordCurrentIdentities(kind, mode, root, { precondition });
  const load = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const provenance = await load('provenance.json');
  for (const artifact of provenance.artifacts) {
    assert.equal(path.basename(artifact.path), artifact.path);
    assert.equal(digest(await readFile(path.join(root, artifact.path))), artifact.sha256);
  }
  assert.equal((await load('private-cleanup.json')).privateInstanceRemoved, true);
  const [summary, http, stages, caseStages] = await Promise.all(['summary.json', 'native-http.json', 'stages.json', 'case-stages.json'].map(load));
  assert.equal(summary.passed, true);
  assert.ok(Object.values(summary.checks).every(Boolean));
  assert.deepEqual(http.records.map(record => [record.name, record.index, record.query]),
    input.fixture.cases.flatMap(testCase => (testCase.parallelQueries
      ?? Array.from({ length: testCase.parallelRequests ?? 1 }, () => testCase.query))
      .map((query, index) => [testCase.name, index, query])));
  return { root, input, summary, http, stages, caseStages };
}

function addedRows(snapshot, before) {
  const ids = new Set(before.database.BaseItems.map(row => idKey(row.Id)));
  assert.deepEqual(snapshot.database.BaseItems.filter(row => ids.has(idKey(row.Id))), before.database.BaseItems,
    'Identity requests preserve every existing BaseItems column.');
  for (const table of Object.keys(before.database).filter(name => name !== 'BaseItems')) {
    assert.deepEqual(snapshot.database[table], before.database[table], `Identity requests preserve ${table}.`);
  }
  const added = snapshot.database.BaseItems.filter(row => !ids.has(idKey(row.Id)));
  assert.equal(new Set(added.map(row => idKey(row.Id))).size, added.length);
  return added;
}

export function identityRowContract(row, interval, creationDates = true) {
  assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  return Object.fromEntries(columns.map(column => {
    const value = row[column.name], type = column.clrType.replace('?', '');
    if (creationDates && clockColumns.has(column.name)) {
      const ticks = dateTicks(value);
      assert.ok(ticks >= dateTicks(interval.startedAt) && ticks <= dateTicks(interval.finishedAt) + 10000n,
        `Created ${column.name} belongs to its actual operation window.`);
      return [column.name, '$creation-clock'];
    }
    return [column.name, value == null ? value : type === 'Guid' ? idKey(value)
      : type === 'bool' ? Boolean(value) : type === 'long' ? String(value)
        : column.name === 'Path' ? value.replaceAll('\\', '/') : value];
  }));
}

function responseProjection(actual, native, rows, nativeRows) {
  // If requested, DateCreated is bound to the observed row rather than dropped.
  for (const [responses, field, observed] of [[actual.cases.flatMap(entry => entry.endpoints.map(endpoint => endpoint.response)), 'body', rows],
    [native.records.map(record => record.response), 'bodyJson', nativeRows]]) {
    const byId = new Map(observed.map(row => [idKey(row.Id), row]));
    for (const response of responses) {
      if (response[field] !== undefined) assert.deepEqual(JSON.parse(response.bodyText), response[field]);
      for (const item of response[field]?.Items ?? []) if (Object.hasOwn(item, 'DateCreated')) {
        const row = byId.get(idKey(item.Id));
        assert.ok(row, 'Returned identity has an observed persisted row.');
        assert.equal(dateTicks(item.DateCreated), dateTicks(row.DateCreated));
        item.DateCreated = '$creation-clock';
      }
      if (response[field] !== undefined) response.bodyText = JSON.stringify(response[field]);
    }
  }
}

export async function compareCurrentIdentity(scenario, controls = []) {
  const { input, root } = scenario;
  const scenarioName = `identity-${input.kind}-${input.mode}`;
  const interval = { startedAt: new Date().toISOString() };
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: input.fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName, fields: 'SortName',
    captureStartIndex: true, captureSortNames: true, captureOrder: true, captureResponseBodies: true,
    trackFilesystem: true, captureEndpointStages: true });
  interval.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'candidate.json'), filterEvidenceJson(actual), { flag: 'wx' });
  const candidateBefore = { database: actual.beforeReads, filesystem: actual.filesystemBeforeReads };
  const candidateStages = actual.caseStages.map(stage => ({ name: stage.name, ...stage.after }));
  assert.deepEqual(candidateBefore.filesystem, scenario.stages.before.filesystem);
  assert.equal(actual.caseStages.length, scenario.caseStages.length);
  const candidateAdded = addedRows({ database: actual.afterReads }, candidateBefore);
  const nativeAdded = addedRows(scenario.stages.afterReads, scenario.stages.before);
  assert.equal(candidateAdded.length, input.mode === 'unicode' ? 2 : 1);
  assert.equal(nativeAdded.length, candidateAdded.length);
  const allowed = controls.length ? controls.flatMap(control => control.summary.createdRows
    .map(row => ({ row, interval: control.summary.interval }))) : nativeAdded.map(row => ({ row, interval: scenario.summary.interval }));
  assert.equal(new Set(allowed.map(value => value.row.Name)).size, input.names.length);
  for (const [index, stage] of candidateStages.entries()) {
    const reference = scenario.caseStages[index];
    assert.equal(stage.name, reference.name);
    const currentRows = addedRows({ database: stage.database }, candidateBefore);
    const referenceRows = addedRows(reference.after, scenario.stages.before);
    assert.equal(currentRows.length, referenceRows.length, stage.name);
    assert.deepEqual(stage.filesystem, reference.after.filesystem, stage.name);
    for (const [rows, bounds] of [[currentRows, interval], [referenceRows, scenario.summary.interval]]) for (const row of rows) {
      assert.equal(row.Type, input.entityType);
      assert.ok(input.names.includes(row.Name));
      const expected = allowed.find(value => value.row.Name === row.Name);
      assert.ok(expected, 'A winner must match a separately observed native named row.');
      assert.deepEqual(identityRowContract(row, bounds), identityRowContract(expected.row, expected.interval));
    }
    if (input.mode.startsWith('race') && index > 0) {
      assert.deepEqual(stage.database, candidateStages[0].database, 'Follow-up requests preserve the candidate winner.');
      assert.deepEqual(reference.after.database, scenario.caseStages[0].after.database, 'Follow-up requests preserve the native winner.');
    }
  }
  assert.deepEqual(actual.afterReads, candidateStages.at(-1).database);
  assert.deepEqual(actual.afterShutdown, actual.afterReads);
  assert.deepEqual(scenario.stages.afterShutdown, scenario.stages.afterReads);
  assert.deepEqual(actual.filesystemAfterReads, scenario.stages.afterReads.filesystem);
  assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
  assert.ok(Object.values(actual.cleanup).every(value => value === true));
  const projected = structuredClone(actual), native = structuredClone(scenario.http);
  responseProjection(projected, native, candidateAdded, nativeAdded);
  const comparison = assertCompleteFilterHttpResponses(projected, native,
    { scenarioName, nativeServerId: scenario.summary.nativeServerId });
  await writeFile(path.join(root, 'comparison.json'), filterEvidenceJson({ ...comparison, kind: input.kind, mode: input.mode,
    createdRows: candidateAdded.length, candidateInterval: interval, nativeInterval: scenario.summary.interval,
    independentWinners: { candidate: candidateAdded.map(row => row.Name), native: nativeAdded.map(row => row.Name) },
    completeCreatedRows: true, existingRowsAndRelationshipsUnchanged: true, repeatedWinnerUnchanged: true,
    cleanup: actual.cleanup }), { flag: 'wx' });
  return { actual, comparison };
}
