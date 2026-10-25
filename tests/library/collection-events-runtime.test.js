import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
const ids = Array.from({ length: 10 }, (_, index) => '8b000000-0000-0000-0000-' + String(index + 1).padStart(12, '0'));
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(validationOutputRoot(), 'collection-events-'));
  let database, runtime;
  const heldEvents = new Set();
  t.after(async () => {
    const errors = [];
    for (const dispose of [async () => { for (const event of heldEvents) await event.release(); },
      () => runtime?.close(), () => dropPostgresTestDatabase(database), () => fs.rm(root, { recursive: true, force: true })]) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Event runtime cleanup failed.');
  });
  const program = path.join(root, 'program'), config = path.join(root, 'config');
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, 'system.xml'), '<ServerConfiguration><ContentTypes/></ServerConfiguration>');
  database = await createPostgresTestDatabase(null, 'collection_event');
  for (const [index, Id] of ids.entries()) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: movieType, Name: 'Initial ' + index, SortName: 'Movie ' + index, MediaType: 'Video', IsMovie: true,
    Path: 'Z:\\EventMedia\\Movie' + index + '.mkv', OfficialRating: 'PG', Data: '{}',
    DateCreated: '2026-10-14 00:00:00.0000000', DateModified: '2026-10-14 00:00:00.0000000',
  }));
  runtime = await createTestRuntime({ database, programDataPath: program, configurationDirectoryPath: config,
    dataPath: path.join(program, 'data'), metadataPath: path.join(program, 'metadata'),
    configuration: { CacheSize: 3, UICulture: 'en-US', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true },
    serverId: 'collection-events' });
  runtime.libraryConfiguration.sleep = async () => {};
  runtime.metadata.queue = () => {};
  return { runtime, database, heldEvents };
}
test('postgres: one Collection event retains typed request instances, duplicate order and shutdown ownership across cache eviction', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  await fs.mkdir(validationOutputRoot(), { recursive: true });
  const { runtime, database, heldEvents } = await fixture(t);
  const created = await runtime.collections.create({ Name: 'Retained Event', ItemIdList: [] });
  let event, eventCount = 0, saveCount = 0, queueCount = 0;
  const originalSave = runtime.collections.updateRepository.bind(runtime.collections);
  runtime.collections.updateRepository = async item => { saveCount++; return originalSave(item); };
  runtime.metadata.queue = () => { queueCount++; };
  runtime.collections.on('ItemsAddedToCollection', ({ Items }) => { eventCount++; event = Items.retain(); heldEvents.add(event); });
  await runtime.collections.add(created.Id, [ids[0], ids[0], ids[1]]);
  assert.equal(eventCount, 1); assert.equal(saveCount, 1); assert.equal(queueCount, 1);
  assert.equal(event.count, 3n);
  // A cold repository value is different from the exact event request cohort.
  await database.update('BaseItems', { Id: ids[0] }, { Name: 'Cold replacement' });
  // TU-Q retains accessed warm entries while one-off loads cycle through cold.
  // Mark each replacement as accessed so insertion also advances the warm queue.
  for (const id of ids.slice(2)) {
    await runtime.itemCreation.withItem(id, async () => {});
    await runtime.itemCreation.withItem(id, async () => {});
  }
  assert.equal(runtime.itemCreation.getCachedItemById(ids[0]), null, 'The request entity must leave the bounded cache before cold loading.');
  const cold = await runtime.itemCreation.getItemById(ids[0]);
  assert.equal(cold.Name, 'Cold replacement');
  const page = await event.page({ limit: 2 });
  try {
    assert.deepEqual(page.entries.map(entry => idKey(entry.Item.Id)), [ids[0], ids[0]].map(idKey));
    assert.equal(page.entries[0].Item, page.entries[1].Item);
    assert.equal(page.entries[0].Item.Name, 'Initial 0');
    page.entries[0].Item.Name = 'Event branch';
    page.entries[0].Item.Tags.push('event-tag');
  } finally { await page.release(); }
  const reread = await event.page({ limit: 1 });
  try { assert.equal(reread.entries[0].Item.Name, 'Event branch'); assert.deepEqual(reread.entries[0].Item.Tags, ['event-tag']); }
  finally { await reread.release(); }
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await assert.rejects(runtime.collections.add(created.Id, []), { status: 503 });
  assert.equal(closed, false, 'Shutdown must wait for the retained event cohort.');
  await event.release(); await closing; assert.equal(closed, true);
});
