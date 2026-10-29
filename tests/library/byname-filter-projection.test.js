import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { projectIdentifiers, seedNativeByNameFilterInput } from '../helpers/byname-filter-input.js';
import { projectProblemSummary } from '../helpers/http-problem-summary.js';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';

export const requiredValidationServices = ['postgres'];

const nativePhysical = '13572468-1111-4222-8333-555555555555';
const fixturePhysical = '24681357-2222-4333-8444-666666666666';
const nativeCollection = '11112222-3333-4444-8555-666677778888';
const fixtureCollection = '88887777-6666-4555-8444-333322221111';
const mappings = new Map([[idKey(nativePhysical), fixturePhysical], [idKey(nativeCollection), fixtureCollection]]);

test('limited problem summaries omit only validated root traces while raw errors remain intact', () => {
  const body = { status: 400, title: 'Bad request', traceId: 'actual-request',
    errors: { traceId: ['Invalid traceId input.'], Other: ['actual-request'] },
    Unknown: { traceId: 'business value', ServerId: 'provider server' } };
  const raw = structuredClone(body), text = JSON.stringify(body);
  assert.deepEqual(projectProblemSummary(body, 400), { status: 400, title: 'Bad request',
    errors: body.errors, Unknown: body.Unknown });
  assert.deepEqual(body, raw);
  assert.equal(JSON.stringify(body), text);
  const absent = structuredClone(body); delete absent.traceId;
  assert.deepEqual(projectProblemSummary(absent, 400), projectProblemSummary(body, 400),
    'A historical limited summary does not establish trace presence.');
  const wire = (value, native = false) => ({ status: 400, contentType: 'application/json; charset=utf-8',
    bodyText: JSON.stringify(value), [native ? 'bodyJson' : 'body']: value });
  assert.throws(() => assertCompleteFilterHttpResponses({ serverId: 'candidate-controller',
    cases: [{ name: 'error', endpoints: [{ endpoint: 'items', response: wire(absent) }] }] },
  { records: [{ name: 'error', endpoint: 'items', response: wire(body, true) }] },
  { nativeServerId: 'native-controller' }), 'The full HTTP comparison must retain the missing root trace as a difference.');
  for (const traceId of ['', null, 3]) assert.throws(() => projectProblemSummary({ ...body, traceId }, 400));
  assert.deepEqual(projectProblemSummary(body, 200), body);
  const corrupted = structuredClone(body); corrupted.errors.traceId[0] = 'Different binding result.';
  assert.notDeepEqual(projectProblemSummary(corrupted, 400), projectProblemSummary(body, 400));
});

test('by-name HTTP fixture binding preserves opaque and unknown identity-like values', () => {
  const opaque = { Id: idKey(nativePhysical), ParentId: idKey(nativeCollection), ServerId: 'provider-server',
    traceId: 'provider-trace', Path: '/stopped/library', Name: idKey(nativePhysical) };
  const body = { Items: [{ Id: idKey(nativePhysical), Type: 'Movie', ParentId: idKey(nativeCollection),
    Name: idKey(nativePhysical), ProviderIds: { ...opaque }, Unknown: { ...opaque, Type: 'Movie' } }],
  TotalRecordCount: 1, StartIndex: 0 };
  const projected = projectIdentifiers(body, mappings);
  assert.equal(projected.Items[0].Id, idKey(fixturePhysical));
  assert.equal(projected.Items[0].ParentId, idKey(fixtureCollection));
  assert.equal(projected.Items[0].Name, idKey(nativePhysical));
  assert.deepEqual(projected.Items[0].ProviderIds, opaque);
  assert.deepEqual(projected.Items[0].Unknown, { ...opaque, Type: 'Movie' });
  const corrupted = structuredClone(body);
  corrupted.Items[0].ProviderIds.Id = idKey(fixturePhysical);
  assert.notDeepEqual(projectIdentifiers(corrupted, mappings), projected);
  assert.deepEqual(body.Items[0].ProviderIds, opaque);
});

const blankItem = (Id, Type, Name, Path, Data) => ({
  ...Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false : column.type === 'TEXT' ? ''
        : ['long', 'uint'].includes(type) ? 0n : 0];
  })),
  Id, Type, Name, Path, Data, IsFolder: true,
});

test('by-name input replay preserves raw Data TEXT in actual PostgreSQL except typed identity/path tokens', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const schema = 'byname_projection_' + randomUUID().replaceAll('-', '').slice(0, 16);
  let database;
  t.after(async () => {
    const failures = [];
    try { await database?.close(); } catch (error) { failures.push(error); }
    const cleanup = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try {
      await cleanup.connect();
      await cleanup.query('DROP SCHEMA IF EXISTS ' + quoteIdentifier(schema) + ', ' + quoteIdentifier(schema + '__mm') + ' CASCADE');
      assert.deepEqual((await cleanup.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])',
        [[schema, schema + '__mm']])).rows, []);
    } catch (error) { failures.push(error); }
    finally { try { await cleanup.end(); } catch (error) { failures.push(error); } }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'By-name projection fixture cleanup failed.', { cause: failures[0] });
  });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const sourcePath = '/stopped/native-library';
  const text = (physicalId, physicalPath) => '{\r\n "PhysicalFolderIds" : ["' + physicalId
    + '"], "PhysicalLocationsList" : [' + JSON.stringify(physicalPath)
    + '], "Unknown":{"Id":"' + nativePhysical + '","Path":' + JSON.stringify(sourcePath)
    + ',"long":9007199254740993}, "Duplicate":1, "Duplicate":2, "Escaped":"\\u0061"\n}\n';
  const physical = blankItem(nativePhysical, 'MediaBrowser.Controller.Entities.Folder', 'Physical', sourcePath, null);
  const collection = blankItem(nativeCollection, 'MediaBrowser.Controller.Entities.CollectionFolder',
    'Library', '/stopped/root/default/Library', text(nativePhysical, sourcePath));
  await database.insert('BaseItems', { ...physical, Id: fixturePhysical.toUpperCase() });
  await database.insert('BaseItems', { ...collection, Id: fixtureCollection.toUpperCase() });
  const fixture = { items: [
    { id: fixturePhysical, key: 'physical', type: 'Folder', name: physical.Name, nativeManaged: true },
    { id: fixtureCollection, key: 'collection', type: 'CollectionFolder', name: collection.Name, nativeManaged: true },
  ] };
  const programDataPath = path.join(tmpdir(), 'mm-byname-projection-' + randomUUID());
  await seedNativeByNameFilterInput({ database, fixture, programDataPath }, {
    mapping: { physical: { actualId: nativePhysical, fixtureId: fixturePhysical },
      collection: { actualId: nativeCollection, fixtureId: fixtureCollection } },
    identifiers: mappings, stages: { beforeReads: { tables: { BaseItems: [physical, collection] } } },
  });
  const [persisted] = await database.rows('BaseItems', { where: { Id: fixtureCollection.toUpperCase() } });
  assert.equal(persisted.Data, text(fixturePhysical, path.join(programDataPath, 'library-content', 'physical')));
  assert.equal(persisted.Path, path.join(programDataPath, 'root/default', collection.Name));
  assert.equal((await database.rows('BaseItems', { where: { Id: fixturePhysical.toUpperCase() } }))[0].Data, null);
  assert.equal(collection.Data, text(nativePhysical, sourcePath));
});
