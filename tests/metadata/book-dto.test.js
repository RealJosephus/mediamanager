import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRuntime } from '../../src/runtime.js';
import { projectItem } from '../../src/library/dto.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const provenance = JSON.parse(await readFile(new URL('./fixtures/book-dto/provenance.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readBound = async entry => {
  const bytes = await readFile(entry.filename);
  assert.equal(hash(bytes), entry.sha256, entry.filename);
  return bytes;
};
const raw = JSON.parse(await readBound(provenance.rawNative));
const observations = provenance.observations.map(name => raw.results.find(sample => sample.name === name));
const wireSeries = dto => JSON.parse(stringifyNativeJson({ SeriesName: dto.SeriesName }));

test('Book DTO observations bind the unchanged native recording, actual service source and serializer layer', async () => {
  const record = JSON.parse(await readBound(provenance.record));
  const binding = JSON.parse(await readBound(provenance.sourceBinding));
  for (const source of provenance.sources) await readBound(source);
  for (const source of provenance.oracleInputs) {
    await readBound(source);
    const name = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(record.sourceFiles.find(entry => entry.filename.replaceAll('\\', '/').split('/').at(-1) === name)?.sha256, source.sha256);
  }
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
  assert.equal(record.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(record.sourceFilesSha256, binding.sourceFilesSha256);
  assert.equal(binding.record.sha256, provenance.record.sha256);
  assert.equal(binding.rawOutput.sha256, provenance.rawNative.sha256);
  assert.equal(raw.results.length, 38); assert.equal(observations.length, 3);
  assert.ok(observations.every(Boolean));
  assert.deepEqual(observations.map(wireSeries), [{}, { SeriesName: '' }, { SeriesName: 'Book series' }]);
});

test('Book item DTO projection preserves native SeriesName wire values without requesting an optional field', async t => {
  for (const observation of observations) await t.test(observation.name, async () => {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Book');
    item.SeriesName = observation.SeriesName;
    const dto = await projectItem(item, {}, null, { fields: new Set(), enableImages: false }, { serverId: 'book-dto' });
    assert.deepEqual(wireSeries(dto), wireSeries(observation));
  });
});

test('PostgreSQL Book item service and HTTP query expose native SeriesName null, empty and curated values', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(null, 'book_dto');
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
  runtime = await createRuntime({ database, configuration: { IsStartupWizardCompleted: true }, serverId: 'book-dto' });
  const key = await runtime.apiKeys.create('Book DTO comparison');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const [index, observation] of observations.entries()) await t.test(observation.name, async () => {
    const id = `cf700000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: 'MediaBrowser.Controller.Entities.Book',
      Name: 'Stored book', SortName: 'stored book', CleanName: 'stored book', SeriesName: observation.SeriesName, MediaType: 'Book', Data: null }));
    const before = (await database.rows('BaseItems', { where: { Id: id } }))[0];
    assert.deepEqual(wireSeries(await runtime.library.getItem(id, { fields: '' })), wireSeries(observation));
    const response = await fetch(`${origin}/Items?ids=${id}&fields=&enableImages=false&enableUserData=false`,
      { headers: { Authorization: `MediaBrowser Token="${key.AccessToken}"` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.Items.length, 1); assert.deepEqual(wireSeries(body.Items[0]), wireSeries(observation));
    assert.equal(Object.hasOwn(body.Items[0], 'SeriesName'), observation.SeriesName !== null);
    assert.deepEqual((await database.rows('BaseItems', { where: { Id: id } }))[0], before);
  });
});
