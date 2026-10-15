import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setupChildrenFixture, useIdentityPathReversalControl } from './children-fixture.js';
import { PeopleMetadataLifecycleHost } from '../../src/metadata/people-lifecycle.js';
import { saveMetadataItem } from '../../src/metadata/save-item.js';
import { persistPeopleCredits } from '../../src/metadata/persistence.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, MIN_DATE, idKey } from '../../src/library/records.js';

const root = new URL('./fixtures/people-lifecycle/', import.meta.url);
const [native, input, provenance] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const parentId = '96000000-0000-0000-0000-000000000001', oldId = '96000000-0000-0000-0000-000000000002';
const originalDate = '2025-01-02T03:04:05.0000000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const comparison = value => ({ ...value, calls: value.calls.map(call => call.action === 'save'
  ? { ...call, item: Object.fromEntries(Object.entries(call.item).filter(([key]) => key !== 'ProviderIds')) } : call) });
const compare = (actual, expected) => assert.deepEqual(comparison(actual), comparison(expected));

test('people lifecycle recording binds native assembly, raw inputs, mapper and real SQL boundaries', async () => {
  for (const [key, file] of Object.entries(provenance.files)) {
    const url = key === 'buildProperties' ? new URL('../Directory.Build.props', import.meta.url) : new URL(file.path.split('/').at(-1), root);
    assert.equal(hash(await readFile(url)), file.sha256, key);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 33); assert.equal(native.results.length, input.length);
  assert.equal(new Set(native.results.map(sample => sample.name)).size, input.length);
  assert.deepEqual(native.results.filter(sample => sample.exception).map(sample => sample.exception), input.filter(sample => sample.expectException).map(sample => sample.expectException));
});

test('people lifecycle comparison detects missing creation events and rolled-back parent/credits', () => {
  for (const name of ['new-person', 'save-item-credits-failure-retains-parent', 'final-person-save-failure-retains-initial']) {
    const expected = native.results.find(sample => sample.name === name), changed = structuredClone(expected);
    if (name === 'new-person') changed.calls = changed.calls.filter(call => call.action !== 'added');
    else if (name.includes('credits')) changed.parentName = 'Original Parent';
    else changed.items = [];
    assert.throws(() => compare(changed, expected), { code: 'ERR_ASSERTION' });
  }
});

async function fixtureFor(t, dialect, sample) {
  const fixture = await setupChildrenFixture(t, dialect);
  useIdentityPathReversalControl(fixture);
  fixture.configuration.EnableCaseSensitiveItemIds = sample.caseSensitive ?? false;
  fixture.configuration.EnableNormalizedItemByNameIds = sample.normalized ?? true;
  await fixture.seed({ target: 'parent', items: [{ key: 'parent', type: sample.unsupported ? 'Person' : 'Movie', Id: parentId, Name: 'Original Parent' }] });
  await fixture.database.insert('Peoples', { Id: oldId, Name: 'Old Credit', PersonType: 'Actor' });
  await fixture.database.insert('PeopleBaseItemMap', { ItemId: parentId, PeopleId: oldId, Role: 'Old Role', ListOrder: 0, SortOrder: null });
  const loaded = await fixture.loadContext(parentId), updates = fixture.host.updates;
  const lifecycle = new PeopleMetadataLifecycleHost({ store: fixture.store, loaded, updates });
  for (const definition of sample.existing ?? []) {
    const person = await lifecycle.createPerson(definition.Name);
    person.item.DateCreated = person.item.DateModified = person.item.DateLastSaved = originalDate;
    person.item.Overview = 'Original Person'; person.item.ProviderIds = definition.ProviderIds ?? {};
    await lifecycle.createItems(person);
  }
  if (sample.directoryFailure) {
    const failedPath = loaded.personIdentity(sample.directoryFailure).Path;
    await mkdir(path.dirname(failedPath), { recursive: true }); await writeFile(failedPath, 'blocked directory');
  }
  const calls = [], cancellation = new AbortController();
  if (sample.cancelled) cancellation.abort(Object.assign(new Error('Injected cancellation'), { nativeException: 'OperationCanceledException' }));
  const projection = (item, images = []) => ({ Id: item.Id.toLowerCase(), Name: item.Name, Type: item.Type,
    Path: item.Path?.replace(fixture.stateRoot, '$STATE') ?? null,
    saved: item.DateLastSaved != null && dateText(item.DateLastSaved) !== MIN_DATE,
    ProviderIds: { ...item.ProviderIds }, imageCount: images.length });
  let personSaves = 0;
  const originalInsert = fixture.database.insert.bind(fixture.database), originalUpdate = fixture.database.update.bind(fixture.database);
  const inspect = async (row, changes) => {
    if (!['MediaBrowser.Controller.Entities.Person', 'MediaBrowser.Controller.Entities.Movies.Movie'].includes(row.Type)) return;
    const item = { ...row, ...changes, Type: row.Type.split('.').at(-1) };
    calls.push({ action: 'save', item: projection(item), cancellable: item.Type === 'Movie' });
    if (item.Type === 'Person' && ++personSaves === (sample.failureAt ?? 1) && sample.failure === 'person'
      || item.Type === 'Movie' && sample.failure === 'parent') throw Object.assign(new Error('Injected save failure'), { nativeException: 'IOException' });
  };
  fixture.database.insert = async (table, row) => {
    if (table === 'BaseItems') await inspect(row, {});
    return originalInsert(table, row);
  };
  fixture.database.update = async (table, where, changes) => {
    if (table === 'BaseItems') await inspect((await fixture.database.rows(table, { where }))[0], changes);
    return originalUpdate(table, where, changes);
  };
  updates.on('ItemAdded', ({ Item, Parent }) => {
    calls.push({ action: 'added', item: projection(Item), parent: Parent?.Id.toLowerCase() ?? null });
    if (sample.cancelOnAdded) cancellation.abort(Object.assign(new Error('Injected cancellation'), { nativeException: 'OperationCanceledException' }));
    if (sample.eventThrows) throw new Error('Injected event failure');
  });
  updates.on('ItemUpdated', ({ Item, UpdateReason }) => calls.push({ action: 'updated', item: projection(Item), reason: UpdateReason }));
  const originalPeople = updates.updatePeople.bind(updates);
  updates.updatePeople = async (context, people, options) => {
    if (!sample.unsupported && people != null) calls.push({ action: 'credits', people: people.filter(Boolean).map(person => ({ Name: person.Name, Type: person.Type,
      Role: person.Role ?? null, SortOrder: person.SortOrder ?? null, ProviderIds: { ...person.ProviderIds } })) });
    if (sample.failure === 'credits') throw Object.assign(new Error('Injected credits failure'), { nativeException: 'IOException' });
    return originalPeople(context, people, options);
  };
  return { ...fixture, loaded, updates, calls, cancellation };
}

async function capture(fixture, sample, exception) {
  const { database, calls, stateRoot } = fixture;
  const names = await database.rows('Peoples');
  const credits = (await database.rows('PeopleBaseItemMap', { where: { ItemId: parentId } })).sort((a, b) => a.ListOrder - b.ListOrder)
    .map(row => ({ Name: names.find(person => person.Id === row.PeopleId).Name, Type: names.find(person => person.Id === row.PeopleId).PersonType,
      Role: row.Role, ListOrder: row.ListOrder, SortOrder: row.SortOrder }));
  const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
  const items = (await database.rows('BaseItems')).filter(row => row.Id !== parentId && row.Type !== 'PLACEHOLDER').sort((a, b) => a.Id.toLowerCase().localeCompare(b.Id.toLowerCase()))
    .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value != null && columns.get(key)?.clrType.includes('Guid')) value = value.toLowerCase();
      if (value != null && ['DateCreated', 'DateModified', 'DateLastSaved'].includes(key)) value = value.startsWith('2025-') ? dateText(value) : '$RECENT';
      else if (value != null && columns.get(key)?.clrType.includes('DateTime')) value = dateText(value);
      if (typeof value === 'bigint') value = Number(value);
      if (key === 'Path' && value) value = value.replace(stateRoot, '$STATE');
      return [key, value];
    })));
  const providers = (await database.rows('BaseItemProviders')).filter(row => row.ItemId !== parentId).map(row => ({ ...row, ItemId: row.ItemId.toLowerCase() }))
    .sort((a, b) => a.ItemId.localeCompare(b.ItemId) || a.ProviderId.localeCompare(b.ProviderId));
  let directories = [];
  try { directories = (await readdir(path.join(stateRoot, 'metadata'), { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory())
    .map(entry => path.join(entry.parentPath, entry.name).replace(stateRoot, '$STATE')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { name: sample.name, exception, calls, credits, items, providers, directories,
    parentName: (await database.rows('BaseItems', { where: { Id: parentId } }))[0].Name,
    ancestors: (await database.rows('AncestorIds')).length, images: (await database.rows('BaseItemImageInfos')).length };
}

for (const dialect of ['postgres']) for (const source of input) test(`${dialect}: real person lifecycle ${source.name}`, async t => {
  const sample = structuredClone(source), fixture = await fixtureFor(t, dialect, sample);
  let exception = null;
  try {
    if (sample.mode === 'save-item') {
      fixture.loaded.item.Name = 'Saved Parent';
      await saveMetadataItem(fixture.updates, fixture.loaded, { Item: fixture.loaded.item, People: sample.people }, 8, { signal: fixture.cancellation.signal });
    } else await fixture.updates.updatePeople(fixture.loaded, sample.people, { signal: fixture.cancellation.signal });
  } catch (error) { exception = error.nativeException ?? error.constructor.name; }
  compare(await capture(fixture, sample, exception), native.results.find(result => result.name === sample.name));
});

for (const dialect of ['postgres']) test(`${dialect}: committed credits survive a cancelled person lifecycle without creating directories`, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  await fixture.seed({ target: 'movie', items: [{ key: 'movie', type: 'Movie', Id: parentId, Name: 'Movie' }] });
  const loaded = await fixture.loadContext(parentId), people = [{ Name: 'First', Type: 'Actor' }];
  await persistPeopleCredits(fixture.store, loaded, people);
  const cancellation = new AbortController(); cancellation.abort(new Error('Cancelled before person'));
  await assert.rejects(new PeopleMetadataLifecycleHost({ store: fixture.store, loaded, updates: fixture.host.updates }).savePeople(people, { signal: cancellation.signal }), /Cancelled before person/);
  assert.equal((await fixture.database.rows('PeopleBaseItemMap', { where: { ItemId: parentId } })).length, 1);
  assert.equal((await fixture.database.rows('BaseItems')).length, 1);
  assert.equal(loaded.context.images.length, 0);
  assert.equal(idKey(loaded.item.Id), idKey(parentId));
});
