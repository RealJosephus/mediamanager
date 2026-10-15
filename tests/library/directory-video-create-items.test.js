import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { guid, idKey } from '../../src/library/records.js';
import { discoveryFixture, ordinal } from './video-discovery-fixture.js';
import { resolveDirectoryVideo, projectDirectoryItem, projectDirectoryResolution } from './directory-video-fixture.js';

import { seedNativeConstructorControl, insertFailure, completeColumns } from './directory-persistence-fixture.js';

const root = new URL('./fixtures/directory-video-create-items/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('directory CreateItems seals all native columns, complete families and real batch faults', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenDirectoryVideoCreateItems, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 60);
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: actual directory CreateItems ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample, { resolveFile: resolveOrdinaryVideoFile }), { fixture, loaded, calls } = value;
  await seedNativeConstructorControl(fixture, loaded, sample);
  const resolved = await resolveDirectoryVideo(value, sample);
  const resolvedProjection = resolved.map(item => projectDirectoryItem(item, fixture, sample));
  const lookupIds = new Map();
  for (const item of resolved) {
    lookupIds.set(idKey(item.Id), item.Id);
    for (const path of item.LocalAlternateVersions ?? []) if (path) {
      const id = loaded.getNewItemId(path, item.NativeType); lookupIds.set(idKey(id), id);
    }
    if (sample.nullAlternates) item.LocalAlternateVersions = null;
    if (sample.channelOriginal) item.ChannelId = '98C00000-0000-0000-0000-000000000009';
  }
  if (sample.failInsert || sample.failInsertAlternate || sample.failLinks) await insertFailure(fixture, sample);
  const serializeWrites = fixture.store.serializeWrites.bind(fixture.store);
  let writerDepth = 0;
  fixture.store.serializeWrites = (operation, options) => serializeWrites(async database => {
    writerDepth += 1;
    try { return await operation(database); }
    finally { writerDepth -= 1; }
  }, options);
  const registered = new Map(), creator = new ItemCreationService({ ...fixture,
    registerItem: item => registered.set(idKey(item.Id), item) });
  fixture.library.itemCreation = creator;
  t.after(() => creator.close());
  const saveItems = creator.saveItems.bind(creator);
  creator.saveItems = async (items, options) => {
    assert.ok(writerDepth > 0, 'CreateItems keeps resolution and its batch save inside one writer boundary');
    calls.push({ action: 'save', items: items.map(item => projectDirectoryItem(item, fixture, sample)), cancellable: Boolean(options.signal) });
    return saveItems(items, options);
  };
  fixture.library.on('ItemAdded', event => calls.push({ action: 'event', kind: 'added', id: guid(event.Item.Id) }));
  fixture.library.on('ItemRemoved', event => calls.push({ action: 'event', kind: 'removed', id: guid(event.Item.Id) }));
  const controller = new AbortController(); if (sample.cancelled) controller.abort();
  let exception = null;
  value.activate();
  try {
    await fixture.library.createItems(resolved, sample.nullParent ? null : loaded.parent, { signal: sample.cancelled ? controller.signal : undefined });
    if (sample.repeatCreate) await fixture.library.createItems(resolved, loaded.parent);
    for (const mutation of sample.mutateRepeats ?? []) {
      for (const item of resolved) Object.assign(item, structuredClone(mutation));
      await fixture.library.createItems(resolved, loaded.parent);
    }
    if (sample.staleColumns) {
      for (const item of resolved) {
        const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
        const data = parseLosslessJson(row.Data);
        data.UnknownStoredField = 'stale-data';
        await fixture.database.update('BaseItems', { Id: item.Id }, { ...sample.staleColumns,
          Data: JSON.stringify(data, (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value) });
      }
      await fixture.library.createItems(resolved, loaded.parent);
    }
  }
  catch (error) {
    if (sample.nullAlternates && error.nativeException === 'NullReferenceException') exception = 'NullReferenceException';
    else if (sample.cancelled && error === controller.signal.reason) exception = 'OperationCanceledException';
    else if (sample.failInsert || sample.failInsertAlternate || sample.failLinks) {
      assert.match(error.message, /Controlled creation failure/u);
      assert.ok(databaseFault(error, dialect)); exception = 'DbUpdateException';
    } else throw error;
  }
  // The recorder snapshots the complete resolved projection before mutation.
  // Its null-array scenarios fail before SaveItems can project that array.
  const actual = await projectDirectoryResolution(value, sample, [], exception);
  actual.resolved = resolvedProjection;
  const primaryIds = new Set(resolved.map(item => idKey(item.Id)));
  for (const row of actual.rows) if (primaryIds.has(idKey(row.id)) && (row.type.endsWith('.Folder') || sample.useResolveTime)) {
    assert.equal(row.dateCreated, fixture.now); row.dateCreated = '$UTC_RESOLVE';
  }
  actual.ancestors = (await fixture.database.rows('AncestorIds')).map(row => ({ itemId: guid(row.ItemId), parentItemId: guid(row.ParentItemId) }))
    .sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.parentItemId, right.parentItemId));
  actual.providers = (await fixture.database.rows('BaseItemProviders')).map(row => ({ itemId: guid(row.ItemId), providerId: row.ProviderId, providerValue: row.ProviderValue }))
    .sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.providerId, right.providerId));
  actual.columns = await completeColumns(fixture, resolved, sample);
  actual.createdLookup = [];
  for (const id of [...lookupIds.values()].sort((left, right) => ordinal(guid(left), guid(right)))) {
    const item = await creator.getItemById(id);
    actual.createdLookup.push({ id: guid(id), item: item && projectDirectoryItem(item, fixture, sample) });
  }
  if (sample.wrongType || sample.existingType || sample.dropExisting) actual.oldLookupName = (await creator.getItemById(value.oldId))?.Name ?? null;
  const expected = native.results.find(result => result.name === sample.name);
  assert.deepEqual(actual, expected);
  assert.deepEqual([...registered.keys()], exception ? [] : expected.calls.find(call => call.action === 'save').items.map(item => idKey(item.id)));
  for (const item of resolved) if (!exception) assert.equal(registered.get(idKey(item.Id)), item, 'Registration preserves the live entity.');
});

const databaseFault = error => error.code === 'P0001';
