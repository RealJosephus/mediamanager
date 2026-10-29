import assert from 'node:assert/strict';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { decodeValue } from '../../src/database/values.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { projectItemBody } from './http-body-projection.js';
import { projectFixtureGuid, projectItemDataIdentities } from './fixture-identity-projection.js';

const guid = value => {
  const key = idKey(value);
  assert.match(key, /^[a-f0-9]{32}$/u);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`.toUpperCase();
};
const identifierFields = new Set(['Id', 'ParentId', 'TopParentId', 'DisplayPreferencesId', 'SeriesId', 'SeasonId', 'AlbumId']);
export function projectIdentifiers(value, mappings) {
  return projectItemBody(value, { date: value => value, identity: (value, { field }) => {
    if (!identifierFields.has(field)) return value;
    const projected = projectFixtureGuid(value, mappings);
    return projected === value ? value : idKey(projected);
  } });
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
        else if (column.name === 'Data' && value != null) value = projectItemDataIdentities(value, source.Type, scenario.identifiers, { paths: pathMappings });
        else value = decodeValue(column, column.type === 'TEXT' && value !== null ? nativeTextBytes(value) : value, 'postgres');
        return [column.name, value];
      }));
      row.Id = guid(item.id);
      const { Id, ...values } = row;
      assert.equal(await connection.update('BaseItems', { Id }, values), 1n);
    }
  });
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
