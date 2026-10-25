import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { projectItem } from '../../src/library/dto.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { bookInput, captureBook, recordBookCandidate } from './fixtures/book-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const input = await bookInput('dto');
let observations;
before(async () => { observations = (await captureBook('dto')).native.results; });
const wireSeries = dto => JSON.parse(stringifyNativeJson({ SeriesName: dto.SeriesName }));

test('Book DTO observations bind independently repeated current property mapping and actual serializer output', async () => {
  const { report } = await captureBook('dto');
  assert.equal(report.independentNativeCapturesAgree, true);
  assert.deepEqual(observations.map(row => row.name), input.cases.map(row => row.name));
  assert.deepEqual(observations.map(row => row.wire), [{}, { SeriesName: '' }, { SeriesName: 'Book series' }]);
});

test('Book item DTO projection preserves native SeriesName wire values without requesting an optional field', async t => {
  for (const observation of observations) await t.test(observation.name, async () => {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Book');
    item.SeriesName = observation.SeriesName;
    const dto = await projectItem(item, {}, null, { fields: new Set(), enableImages: false }, { serverId: 'book-dto' });
    await recordBookCandidate('dto', 'projection-' + observation.name, { dto: JSON.parse(stringifyNativeJson(dto)) });
    assert.deepEqual(wireSeries(dto), observation.wire);
  });
});

test('PostgreSQL Book item service and HTTP query expose native SeriesName null, empty and curated values', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-dto-'));
  let runtime, database;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      try { if (database) await dropPostgresTestDatabase(database); }
      finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('book-dto-'));
        await rm(directory, { recursive: true });
      }
    }
  });
  database = await createPostgresTestDatabase(null, 'book_dto');
  runtime = await createTestRuntime({ database, programDataPath: path.join(directory, 'program'),
    configurationDirectoryPath: path.join(directory, 'config'), storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true }, serverId: 'book-dto' });
  const key = await runtime.apiKeys.create('Book DTO comparison');

  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
  for (const [index, observation] of observations.entries()) await t.test(observation.name, async () => {
    const id = `cf700000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: 'MediaBrowser.Controller.Entities.Book',
      Name: 'Stored book', SortName: 'stored book', CleanName: 'stored book', SeriesName: observation.SeriesName, MediaType: 'Book', Data: null }));
    const before = (await database.rows('BaseItems', { where: { Id: id } }))[0];
    const dto = await runtime.library.getItem(id, { fields: '' });
    const response = await fetch(`${origin}/Items?ids=${id}&fields=&enableImages=false&enableUserData=false`,
      { headers: { Authorization: `MediaBrowser Token="${key.AccessToken}"` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    await recordBookCandidate('dto', 'http-' + observation.name, { service: JSON.parse(stringifyNativeJson(dto)), http: body });
    assert.deepEqual(wireSeries(dto), observation.wire);
    assert.equal(body.Items.length, 1); assert.deepEqual(wireSeries(body.Items[0]), observation.wire);
    assert.equal(body.Items[0].Name, 'Stored book'); assert.equal(body.Items[0].Type, 'Book');
    assert.equal(Object.hasOwn(body.Items[0], 'SeriesName'), Object.hasOwn(observation.wire, 'SeriesName'));
    assert.deepEqual((await database.rows('BaseItems', { where: { Id: id } }))[0], before);
  });
});
