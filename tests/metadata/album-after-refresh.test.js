import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setupChildrenFixture } from './children-fixture.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { afterAlbumMetadataRefresh } from '../../src/metadata/album-after-refresh.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/album-after-refresh/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const albumId = '95000000-0000-0000-0000-000000000001';
const trackId = '95000000-0000-0000-0000-000000000002';
const oldPersonId = '95000000-0000-0000-0000-000000000003';
const capturePerson = person => ({ Name: person.Name, Type: person.Type, Role: person.Role ?? null,
  SortOrder: person.SortOrder ?? null, ProviderIds: person.ProviderIds ?? {} });
const compare = (actual, expected) => {
  assert.equal(actual.updateType, expected.updateType);
  assert.equal(actual.exception != null, expected.exception != null);
  assert.deepEqual(actual.calls, expected.calls);
  assert.deepEqual(actual.credits, expected.credits);
};

test('Album After recording seals the real service, PeopleHelper and EF PeopleRepository', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, file] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 49); assert.equal(native.results.length, input.length);
  assert.equal(new Set(native.results.map(sample => sample.name)).size, input.length);
  assert.deepEqual(native.results.filter(sample => sample.exception).map(sample => sample.name), input.filter(sample => sample.expectException).map(sample => sample.name));
});

test('Album comparison detects reversed credits, skipped whitespace cleanup and lost partial save', () => {
  for (const name of ['after-album-artists-before-artists', 'after-blank-members-clear-credits', 'none-people-failure-retains-item-save']) {
    const expected = native.results.find(sample => sample.name === name), changed = structuredClone(expected);
    if (name.includes('before-artists')) changed.credits.reverse();
    else if (name.includes('blank-members')) changed.credits = [{ Name: 'Old Credit' }];
    else changed.calls = changed.calls.filter(call => call.action !== 'item');
    assert.throws(() => compare(changed, expected), { code: 'ERR_ASSERTION' });
  }
});

async function fixtureFor(t, dialect, sample, { rawArtistControls = true } = {}) {
  const fixture = await setupChildrenFixture(t, dialect);
  const definitions = [{ key: 'album', type: 'MusicAlbum', Id: albumId, Name: 'Album', DateLastMediaAdded: '0001-01-01T00:00:00Z',
    PresentationUniqueKey: albumId.replaceAll('-', ''), IsLocked: sample.locked ?? false,
    Artists: sample.artists?.filter(name => name != null) ?? [], AlbumArtists: sample.albumArtists?.filter(name => name != null) ?? [] }];
  if (sample.force) definitions.push({ key: 'track', type: 'Audio', Id: trackId, parent: 'album', Name: 'Track', Album: 'Album',
    Artists: sample.artists, AlbumArtists: sample.albumArtists });
  await fixture.seed({ target: 'album', items: definitions });
  await fixture.database.insert('Peoples', { Id: oldPersonId, Name: 'Old Credit', PersonType: 'Actor' });
  await fixture.database.insert('PeopleBaseItemMap', { ItemId: albumId, PeopleId: oldPersonId, Role: 'Original Role', ListOrder: 0, SortOrder: null });
  const loadContext = Object.assign(async (reference, options) => {
    const loaded = await fixture.loadContext(reference, options);
    // The native recording controls cached arrays directly. Empty strings/null
    // array members are removed by SQL hydration, so preserve that same entity
    // input only here. A separate integration check uses the real DB arrays.
    if (rawArtistControls && loaded.item.Id === albumId) {
      loaded.item.Artists = sample.artists; loaded.item.AlbumArtists = sample.albumArtists;
    }
    return loaded;
  }, fixture.loadContext);
  loadContext.withContext = async (reference, options, operation) => {
    const loaded = await loadContext(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  const host = new MetadataRefreshHost({ registry: fixture.registry, store: fixture.store, linkedChildren: fixture.linkedChildren, vfs: fixture.vfs, loadContext, now: () => fixture.now });
  const closeFixtureHost = fixture.host.close.bind(fixture.host);
  fixture.host.close = async () => {
    const errors = [];
    for (const close of [() => host.close(), closeFixtureHost]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Metadata fixture host cleanup failed.');
  };
  const calls = [], originalUpdate = host.updates.update.bind(host.updates), originalInsert = fixture.database.insert.bind(fixture.database);
  const originalDelete = fixture.database.delete.bind(fixture.database), originalWrite = fixture.database.update.bind(fixture.database);
  host.updates.update = async (...args) => {
    calls.push({ action: 'item', reason: args[2] });
    if (sample.failure === 'item') throw new Error('Injected item save failure');
    return originalUpdate(...args);
  };
  fixture.database.delete = async (table, ...args) => {
    if (sample.failure === 'people' && table === 'PeopleBaseItemMap') throw new Error('Injected people repository failure');
    return originalDelete(table, ...args);
  };
  fixture.database.insert = async (table, row) => {
    return originalInsert(table, row);
  };
  fixture.database.update = async (table, where, changes) => {
    if (sample.failure === 'person' && table === 'BaseItems' && where.Id !== albumId) throw new Error('Injected post-credit person metadata failure');
    return originalWrite(table, where, changes);
  };
  const updatePeople = async (item, people) => {
    calls.push({ action: 'people', people: people.map(capturePerson) });
    await host.updates.updatePeople(await loadContext(item.Id), people);
  };
  if (rawArtistControls) host.updatePeople = updatePeople;
  const credits = async () => {
    const people = await fixture.database.rows('Peoples');
    return (await fixture.database.rows('PeopleBaseItemMap', { where: { ItemId: albumId } })).sort((a, b) => a.ListOrder - b.ListOrder)
      .map(map => ({ Name: people.find(person => person.Id === map.PeopleId).Name, Type: people.find(person => person.Id === map.PeopleId).PersonType,
        Role: map.Role, ListOrder: map.ListOrder, SortOrder: map.SortOrder }));
  };
  return { ...fixture, host, loadContext, calls, updatePeople, credits };
}

for (const dialect of ['postgres']) {
  const options = {};
  for (const sample of input) test(`${dialect}: Album After ${sample.name}`, options, async t => {
    const fixture = await fixtureFor(t, dialect, sample), expected = native.results.find(result => result.name === sample.name);
    let exception = null, updateType = null;
    const controller = new AbortController(); if (sample.cancelled) controller.abort();
    if (sample.cancelAfterSave) fixture.host.updates.on('ItemUpdated', event => { if (event.Item.Id === albumId) controller.abort(); });
    try {
      if (sample.mode === 'after') await afterAlbumMetadataRefresh((await fixture.loadContext(albumId)).item, fixture.updatePeople);
      else updateType = (await fixture.host.refresh(albumId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: sample.force, signal: controller.signal })).UpdateType;
    } catch (error) {
      if (!sample.expectException) throw error;
      exception = { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack };
    }
    assert.equal(exception != null, Boolean(sample.expectException), 'expected failure must occur');
    observeComparison(t, sample.name + ' album failure', exception, expected.exception);
    compare({ updateType, exception, calls: fixture.calls, credits: await fixture.credits() }, expected);
    if (sample.cancelAfterSave) assert.equal(controller.signal.aborted, true);
    const saved = (await fixture.database.rows('BaseItems', { where: { Id: albumId } }))[0];
    assert.equal(saved.DateLastSaved != null, Boolean(sample.force && sample.failure !== 'item'));
    if (!sample.expectException && expected.credits.every(credit => credit.Name !== 'Old Credit')) {
      assert.equal((await fixture.database.rows('Peoples', { where: { Id: oldPersonId } })).length, 0, 'orphan credits are removed');
      const loaded = await fixture.loadContext(albumId);
      const identities = new Set(expected.credits.map(credit => loaded.personIdentity(credit.Name).Id));
      const persons = await fixture.database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Person' } });
      assert.deepEqual(new Set(persons.map(person => person.Id)), identities, 'person entities use the deterministic metadata path identities');
    }
  });
  test(`${dialect}: real stored artist arrays reach Album After without input overrides`, options, async t => {
    for (const name of ['none-artist-only', 'none-empty-preserves-credits', 'none-blank-album-only-clears-credits', 'none-two-kinds-same-name']) {
      const sample = input.find(sample => sample.name === name), fixture = await fixtureFor(t, dialect, sample, { rawArtistControls: false });
      const updated = [], before = (await fixture.database.rows('BaseItems', { where: { Id: albumId } }))[0];
      fixture.host.updates.on('ItemUpdated', event => updated.push(event.Item.Id));
      await fixture.host.refresh(albumId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
      const expected = native.results.find(result => result.name === name);
      assert.deepEqual(await fixture.credits(), expected.credits);
      assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: albumId } }))[0], before);
      assert.deepEqual(updated, [], 'people updates do not emit Album ItemUpdated');
    }
  });
  test(`${dialect}: the production Album people update finishes after post-COMMIT cancellation`, options, async t => {
    const sample = input.find(sample => sample.cancelAfterSave), fixture = await fixtureFor(t, dialect, sample, { rawArtistControls: false });
    const controller = new AbortController(), updated = [];
    fixture.host.updates.on('ItemUpdated', event => { updated.push(event.Item.Id); controller.abort(); });
    const result = await fixture.host.refresh(albumId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: true, signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    const expected = native.results.find(result => result.name === sample.name);
    assert.equal(result.UpdateType, expected.updateType); assert.deepEqual(await fixture.credits(), expected.credits);
    assert.deepEqual(updated, [albumId]);
  });
}
