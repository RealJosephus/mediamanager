import { installPeopleImageSaveProbe } from './people-image-save-probe.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setupChildrenFixture, useIdentityPathReversalControl } from './children-fixture.js';
import { PeopleMetadataLifecycleHost } from '../../src/metadata/people-lifecycle.js';
import { saveMetadataItem } from '../../src/metadata/save-item.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, MIN_DATE } from '../../src/library/records.js';

const root = new URL('./fixtures/people-image-lifecycle/', import.meta.url);
const [native, input, provenance] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const parentId = '96000000-0000-0000-0000-000000000001', oldId = '96000000-0000-0000-0000-000000000002';
const originalDate = '2025-01-02T03:04:05.0000000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const comparison = value => ({ ...value, calls: value.calls.map(call => call.action === 'save'
  ? { ...call, item: Object.fromEntries(Object.entries(call.item).filter(([key]) => key !== 'ProviderIds' && key !== 'imageCount')) } : call) });
const compare = (actual, expected) => assert.deepEqual(comparison(actual), comparison(expected));

test('person image recording binds real assembly, SQL failure controls and exact image bytes', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.imageSha256, provenance.files.image.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 17); assert.equal(native.results.length, input.length);
  assert.equal(new Set(native.results.map(sample => sample.name)).size, input.length);
  assert.deepEqual(native.results.filter(sample => sample.exception).map(sample => sample.exception), input.filter(sample => sample.expectException).map(sample => sample.expectException));
});

test('person image comparison detects omitted image saves and reverted partial commits', () => {
  for (const name of ['new-remote-primary', 'final-save-io-retains-local-image', 'existing-image-insert-failure-retains-deletion']) {
    const expected = native.results.find(sample => sample.name === name), changed = structuredClone(expected);
    if (name === 'new-remote-primary') changed.calls = changed.calls.filter(call => call.action !== 'images');
    else if (name.includes('final-save')) changed.files = [];
    else changed.images = [{ ItemId: expected.items[0].Id, Path: expected.files[0].Path, Width: 1, Height: 1 }];
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
    if (definition.primary) {
      const imagePath = definition.primary === 'local' ? path.join(person.item.Path, 'folder.png') : definition.primary;
      if (definition.primary === 'local') await writeFile(imagePath, await readFile('tests/images/fixtures/processor/original-http.png'));
      person.context.images.push({ Path: imagePath, Type: 'Primary', Width: 1, Height: 1, Blurhash: Buffer.from('controlled'), DateModified: MIN_DATE });
    }
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
  fixture.host.images.processor.getImageSize = async () => {
    if (sample.dimensionFailure) throw Object.assign(new Error('Injected image dimension failure'), { nativeException: 'IOException' });
    return sample.dimensions ?? { Width: 1, Height: 1 };
  };
  fixture.host.images.processor.getImageBlurHash = async () => {
    if (sample.blurFailure) throw Object.assign(new Error('Injected image BlurHash failure'), { nativeException: 'IOException' });
    return 'controlled';
  };
  fixture.host.images.fetch = async url => {
    calls.push({ action: 'fetch', url, cancellable: false });
    if (url.endsWith('404')) return new Response('Missing', { status: 404 });
    if (url.endsWith('500')) return new Response('Retryable', { status: 500 });
    if (url.endsWith('io')) throw Object.assign(new Error('Injected image download failure'), { nativeException: 'IOException' });
    return new Response(await readFile('tests/images/fixtures/processor/original-http.png'), { headers: { 'content-type': 'image/png' } });
  };
  let activePerson;
  const reload = loaded.reloadMetadataContext;
  loaded.reloadMetadataContext = async reference => {
    const context = await reload(reference);
    if (context.item.Type === 'Person') activePerson = context;
    return context;
  };
  installPeopleImageSaveProbe(fixture, sample, calls, projection);
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
    calls.push({ action: 'added', item: projection(Item, Item.Type === 'Person' ? activePerson?.context.images ?? [] : []), parent: Parent?.Id.toLowerCase() ?? null });
    if (sample.cancelOnAdded) cancellation.abort(Object.assign(new Error('Injected cancellation'), { nativeException: 'OperationCanceledException' }));
    if (sample.eventThrows) throw new Error('Injected event failure');
  });
  updates.on('ItemUpdated', ({ Item, UpdateReason }) => calls.push({ action: 'updated', item: projection(Item, Item.Type === 'Person' ? activePerson?.context.images ?? [] : []), reason: UpdateReason }));
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
  const imageRows = (await database.rows('BaseItemImageInfos')).sort((a,b) => a.ItemId.localeCompare(b.ItemId))
    .map(row => ({ ItemId: row.ItemId.toLowerCase(), Path: row.Path.replace(stateRoot, '$STATE'), Type: 'Primary', Width: row.Width, Height: row.Height,
      Blurhash: row.Blurhash == null ? null : row.Blurhash.toString('utf8'), DateModified: row.DateModified == null ? null : Number(row.DateModified.slice(0,4)) > 2025 ? '$RECENT' : dateText(row.DateModified) }));
  let files = [];
  try { files = await Promise.all((await readdir(path.join(stateRoot, 'metadata'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(async entry => { const filename = path.join(entry.parentPath, entry.name), bytes = await readFile(filename); return { Path: filename.replace(stateRoot, '$STATE'), bytes: bytes.length, sha256: hash(bytes) }; })); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.sort((a,b) => a.Path < b.Path ? -1 : a.Path > b.Path ? 1 : 0);
  return { name: sample.name, exception, calls, credits, items, providers, directories,
    parentName: (await database.rows('BaseItems', { where: { Id: parentId } }))[0].Name,
    ancestors: (await database.rows('AncestorIds')).length, images: imageRows, files };
}

for (const dialect of ['postgres']) for (const source of input) test(`${dialect}: real person image lifecycle ${source.name}`, async t => {
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
