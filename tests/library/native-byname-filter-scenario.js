import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableDefinition } from '../../src/database/model.js';
import { decodeValue } from '../../src/database/values.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { assertValidationOutputChild, validationFileUrl } from '../../tools/validation/paths.js';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
import { assertNativeByNameFilterOutput, nativeByNameFilterBinding, verifyNativeByNameFilterRecording } from './native-byname-filter-inputs.js';

const guid = value => {
  const key = idKey(value);
  assert.match(key, /^[a-f0-9]{32}$/u);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`.toUpperCase();
};
const identifierFields = new Set(['Id', 'ParentId', 'TopParentId', 'DisplayPreferencesId', 'SeriesId', 'SeasonId', 'AlbumId']);
function projectIdentifiers(value, mappings, field) {
  if (Array.isArray(value)) return value.map(entry => projectIdentifiers(entry, mappings, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, projectIdentifiers(entry, mappings, key)]));
  if (identifierFields.has(field) && typeof value === 'string' && mappings.has(idKey(value))) {
    return idKey(mappings.get(idKey(value)));
  }
  return value;
}

export async function loadNativeByNameFilterScenario(kind, side = null) {
  const binding = await verifyNativeByNameFilterRecording(kind, side);
  const root = validationFileUrl('../../' + binding.logicalRoot + '/', import.meta.url);
  assert.equal(path.resolve(fileURLToPath(root)), path.resolve(binding.repetitions[0].filename));
  const load = name => readFile(new URL(name, root), 'utf8').then(JSON.parse);
  const [http, stages, summary, filesystem] = await Promise.all(['native-http.json', 'database-stages.json', 'summary.json', 'filesystem-stages.json'].map(load));
  assert.equal(summary.passed, true);
  const setup = kind === 'artist' ? null : await load('native-setup.json');
  const mapping = setup?.graph.fixtureKeyMapping ?? {};
  const identifiers = new Map(Object.values(mapping).map(entry => [idKey(entry.actualId), entry.fixtureId]));
  assert.equal(identifiers.size, Object.keys(mapping).length);
  assert.equal(new Set([...identifiers.values()].map(idKey)).size, identifiers.size);
  const preparation = JSON.parse(await readFile(nativeByNameFilterBinding.preparationInputFiles[0].filename, 'utf8'));
  const nativeServerId = preparation.observations.find(entry => entry.route === '/Users/AuthenticateByName').responseBody.SessionInfo.ServerId;
  const [login, ...remaining] = http.records;
  assert.equal(login.request.route, '/Users/AuthenticateByName');
  assert.equal(login.response.status, 200);
  assert.equal(login.response.bodyJson.ServerId, nativeServerId);
  const shutdown = remaining.pop();
  assert.equal(shutdown.request.route, '/System/Shutdown');
  assert.equal(shutdown.response.status, 204);
  assert.equal(remaining.length, binding.endpoints);
  const records = remaining.map(record => {
    assert.equal(record.request.method, 'GET');
    const separator = record.name.lastIndexOf(':');
    assert.ok(separator > 0);
    const name = record.name.slice(0, separator), endpoint = record.name.slice(separator + 1);
    assert.ok(['items', 'legacy'].includes(endpoint));
    const contentType = record.response.headers['content-type'];
    const response = { ...record.response, contentType };
    if (contentType?.includes('json')) {
      assert.deepEqual(JSON.parse(record.response.bodyText), record.response.bodyJson);
      response.bodyJson = projectIdentifiers(record.response.bodyJson, identifiers);
      response.bodyText = JSON.stringify(response.bodyJson);
    } else {
      if (record.response.bodyJson !== undefined) assert.equal(record.response.bodyJson, null);
      delete response.bodyJson;
    }
    return { name, endpoint, request: record.request, response };
  });
  return { recording: binding, root: fileURLToPath(root), http, stages, filesystem, mapping, identifiers, nativeServerId, records };
}

export function projectNativeByNameCandidateInput(input) {
  return { ...input, items: input.items.map(({ nativeExisting, ...item }) => {
    assert.equal(Object.hasOwn(item, 'existingNative'), false);
    if (nativeExisting === undefined) return item;
    assert.equal(nativeExisting, true);
    return { ...item, existingNative: true };
  }) };
}

// Assemble controlled input rows from the stopped native pre-request state.
// Expected HTTP responses and post-request mutations are never used for seeding.
export async function seedNativeByNameFilterInput({ database, fixture, programDataPath }, scenario) {
  const reverseIds = new Map(Object.values(scenario.mapping).map(entry => [idKey(entry.fixtureId), entry.actualId]));
  const sourceRows = new Map(scenario.stages.beforeReads.tables.BaseItems.map(row => [idKey(row.Id), row]));
  const pathMappings = new Map();
  for (const item of fixture.items.filter(item => item.nativeManaged)) {
    const source = sourceRows.get(idKey(reverseIds.get(idKey(item.id)) ?? item.id));
    assert.ok(source, item.key);
    const location = item.type === 'UserRootFolder' ? path.join(programDataPath, 'root/default')
      : item.type === 'CollectionFolder' ? path.join(programDataPath, 'root/default', item.name)
        : path.join(programDataPath, 'library-content', item.key);
    pathMappings.set(source.Path, location);
  }
  const projectValue = value => {
    if (Array.isArray(value)) return value.map(projectValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, projectValue(entry)]));
    if (typeof value === 'string') return pathMappings.get(value)
      ?? (scenario.identifiers.has(idKey(value)) ? idKey(scenario.identifiers.get(idKey(value))) : value);
    return value;
  };
  const columns = tableDefinition('BaseItems').columns;
  await database.transaction(async connection => {
    for (const item of fixture.items) {
      if (item.type === 'AggregateFolder') continue;
      const source = sourceRows.get(idKey(reverseIds.get(idKey(item.id)) ?? item.id));
      assert.ok(source, item.key);
      assert.equal(source.Name, item.name, item.key);
      assert.deepEqual(Object.keys(source).sort(), columns.map(column => column.name).sort());
      const row = Object.fromEntries(columns.map(column => {
        let value = source[column.name];
        if (value != null && column.clrType.replace('?', '') === 'Guid') value = guid(scenario.identifiers.get(idKey(value)) ?? value);
        else if (column.name === 'Path') value = pathMappings.get(value) ?? value;
        else if (column.name === 'Data' && value != null) value = JSON.stringify(projectValue(JSON.parse(value)));
        else value = decodeValue(column, column.type === 'TEXT' && value !== null ? nativeTextBytes(value) : value, 'postgres');
        return [column.name, value];
      }));
      row.Id = guid(item.id);
      const { Id, ...values } = row;
      assert.equal(await connection.update('BaseItems', { Id }, values), 1n);
    }
  });
}

export async function writeCompleteByNameFilterEvidence(actual, scenario, { scenarioName }) {
  const comparison = assertCompleteFilterHttpResponses(actual, { records: scenario.records },
    { scenarioName, nativeServerId: scenario.nativeServerId });
  if (!process.env.MEDIAMANAGER_BYNAME_FILTER_WIRE_EVIDENCE) return comparison;
  assert.match(scenarioName, /^[a-z0-9-]+$/u);
  const root = assertNativeByNameFilterOutput(assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_BYNAME_FILTER_WIRE_EVIDENCE)));
  await mkdir(root, { recursive: true });
  const output = assertNativeByNameFilterOutput(assertValidationOutputChild(path.join(root, scenarioName)));
  await mkdir(output);
  const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
  for (const [name, value] of [['postgres.json', actual], ['native-http.json', scenario.http],
    ['comparison.json', { ...comparison, scenarioName, logicalRoot: scenario.recording.logicalRoot,
      individuallyBoundGraphIdentifiers: scenario.mapping, completeHttpContractEqual: true, releaseAcceptance: false }]]) {
    await writeFile(path.join(output, name), json(value), { flag: 'wx' });
  }
  return comparison;
}

export function assertNativeByNameFilterGetMutation(actual, scenario) {
  const beforeNative = new Set(scenario.stages.beforeReads.tables.BaseItems.map(row => idKey(row.Id)));
  const createdNative = scenario.stages.afterReads.tables.BaseItems.filter(row => !beforeNative.has(idKey(row.Id)));
  const beforeCandidate = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
  const createdCandidate = actual.afterReads.BaseItems.filter(row => !beforeCandidate.has(idKey(row.Id)));
  const stable = row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['DateCreated', 'DateModified'].includes(key))
    .map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]));
  const ordered = rows => rows.map(stable).sort((a, b) => idKey(a.Id).localeCompare(idKey(b.Id), 'en'));
  assert.deepEqual(ordered(createdCandidate), ordered(createdNative));
  for (const row of createdCandidate) for (const key of ['DateCreated', 'DateModified']) {
    assert.match(row[key], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{1,7}$/u);
  }
  assert.deepEqual(actual.afterReads.BaseItems.filter(row => beforeCandidate.has(idKey(row.Id))), actual.beforeReads.BaseItems);
  for (const name of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
    assert.deepEqual(actual.afterReads[name], actual.beforeReads[name], name);
  }
  assert.deepEqual(actual.filesystemBeforeReads, scenario.filesystem.beforeReads.metadata.entries);
  assert.deepEqual(actual.filesystemAfterReads, scenario.filesystem.afterReads.metadata.entries);
  assert.deepEqual(actual.filesystemAfterShutdown, scenario.filesystem.finalAfterShutdown.metadata.entries);
  return { createdRows: createdCandidate.length };
}
