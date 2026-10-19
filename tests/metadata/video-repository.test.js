import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, idKey } from '../../src/library/records.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { saveMetadataItem } from '../../src/metadata/save-item.js';
import { ItemUpdateType, validateMetadataSaves } from '../../src/metadata/save-manager.js';
import { setupChildrenFixture } from './children-fixture.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { MetadataEditService } from '../../src/metadata/edit-service.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

const root = new URL('./fixtures/video-repository/', import.meta.url);
const read = async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'));
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(read));
const defaults = () => ({ Name: null, Path: null, Genres: [], Overview: null, ProductionYear: null, PremiereDate: null,
  CommunityRating: null, OfficialRating: null, ProviderIds: {}, ImageInfos: [], Studios: [], Tags: [], CriticRating: null,
  CustomRating: null, OriginalTitle: null, RunTimeTicks: null, IsLocked: false, LockedFields: [] });
const fields = Object.keys(defaults()).filter(field => field !== 'ImageInfos');
const nativeTypes = Object.freeze({
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Video: 'MediaBrowser.Controller.Entities.Video',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
});
const nativeItem = (type, ...sources) => applyNativeItemValues(newNativeItemEntity(nativeTypes[type]), ...sources);
const normalizeDates = value => ({ ...value,
  PremiereDate: value.PremiereDate == null ? null : dateText(value.PremiereDate),
  ImageInfos: value.ImageInfos.map(image => ({ ...image, DateModified: dateText(image.DateModified) })) });
const project = loaded => structuredClone(normalizeDates({
  ...Object.fromEntries(fields.map(field => [field, loaded.item[field]])),
  ImageInfos: loaded.context.images.map(image => ({ Type: image.Type, Path: image.Path, Width: image.Width ?? 0,
    Height: image.Height ?? 0, DateModified: image.DateModified ?? '0001-01-01T00:00:00' }))
}));

test('video repository oracle seals native propagation, save-item order and exact Int64 evidence', async () => {
  for (const file of provenance.fixtureFiles) {
    const fileUrl = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(fileUrl)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenVideoRepository, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles.find(file => file.path.endsWith('/input.json')).sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 23);
  assert.equal(native.results[0].items[1].item.RunTimeTicks, 9007199254740995n);
});

for (const sample of input) test(`native video repository propagation: ${sample.name}`, async () => {
  const byKey = new Map(sample.items.map(definition => {
    const item = nativeItem(definition.type, defaults(), structuredClone(definition), { IsFileProtocol: false });
    if (item.RunTimeTicks != null) item.RunTimeTicks = BigInt(item.RunTimeTicks);
    return [definition.key, { dispose: async () => {}, item, context: { images: item.ImageInfos } }];
  }));
  const byId = new Map([...byKey.values()].map(loaded => [idKey(loaded.item.Id), loaded]));
  const links = structuredClone(sample.links), owner = byKey.get('owner');
  for (const [key, loaded] of byKey) {
    loaded.getLocalAlternateVersionIds = async () => (links[key] ?? []).map(child => byKey.get(child)?.item.Id
      ?? '98b80000-0000-0000-0000-000000000099');
    loaded.reloadMetadataContext = async reference => {
      const found = byId.get(idKey(reference));
      if (!found) throw Object.assign(new Error('Missing controlled item'), { status: 404 });
      return found;
    };
  }
  const calls = [], commits = [], cancellation = new AbortController();
  const cancelled = Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' });
  if (sample.cancelled) cancellation.abort(cancelled);
  class ControlledUpdates extends MetadataUpdateHost {
    async update(loaded, result, reason, options = {}) {
      const key = result.Item.key;
      const updated = { ...loaded, item: result.Item, context: { ...loaded.context, images: result.Images ?? loaded.context.images } };
      calls.push({ action: 'update', key, reason, item: project(updated),
        sameImages: updated.context.images === owner.context.images,
        sameGenres: result.Item.Genres === owner.item.Genres, sameProviders: result.Item.ProviderIds === owner.item.ProviderIds });
      return super.update(loaded, result, reason, { ...options, persistImages: async () => {},
        persist: async (_updated, _result, { signal }) => {
          signal?.throwIfAborted();
          if (sample.failSave === key) throw Object.assign(new Error('Injected repository failure'), { nativeException: 'IOException' });
          commits.push({ key, reason, item: project(updated) });
          if (sample.cancelAfterSave === key) cancellation.abort(cancelled);
          if (sample.replaceLinksAfterSave?.key === key) links[key] = sample.replaceLinksAfterSave.links;
          if (sample.mutateAfterSave?.key === key) {
            result.Item.Genres[0] = 'Mutated genre'; result.Item.ProviderIds.Injected = '303'; updated.context.images[0].Width = 99;
          }
        } });
    }
    async updatePeople(loaded) { calls.push({ action: 'people', key: loaded.item.key }); }
  }
  const updates = new ControlledUpdates({ images: { updateImages: async () => {} },
    reattach: async (_, item) => { calls.push({ action: 'reattach', key: item.key }); return []; } });
  let exception = null;
  try {
    const result = { Item: owner.item, Images: owner.context.images };
    const options = { signal: cancellation.signal, reattachUserData: sample.saveItem === true };
    if (sample.saveItem) await saveMetadataItem(updates, owner, { ...result, People: [{ Name: 'Controlled person' }] }, sample.reason, options);
    else await updates.update(owner, result, sample.reason, options);
  } catch (error) { exception = error.nativeException ?? error.name; }
  const expected = native.results.find(result => result.name === sample.name);
  const normalized = structuredClone(expected);
  for (const value of [...normalized.calls, ...normalized.commits, ...normalized.items]) if (value.item) value.item = normalizeDates(value.item);
  assert.deepEqual({ name: sample.name, exception, calls, commits, items: [...byKey].map(([key, loaded]) => ({ key, item: project(loaded) })) }, normalized);
});

test('a repository preflight retains active ancestors after live parent links disappear', async () => {
  const ownerId = 'a7180000-0000-0000-0000-000000000031', childId = 'a7180000-0000-0000-0000-000000000032';
  const effects = []; let committed = false, selected = false;
  const owner = { dispose: async () => {}, item: nativeItem('Movie', { Id: ownerId, IsFileProtocol: true }), context: { images: [] },
    libraryOptions: { MetadataSavers: ['Control'] } };
  const child = { dispose: async () => {}, item: nativeItem('Movie', { Id: childId, IsFileProtocol: true }), context: { images: [] },
    libraryOptions: { MetadataSavers: ['Control'] } };
  owner.getLocalAlternateVersionIds = async prospective => {
    if (!committed) return [childId];
    if (!prospective && !selected) { selected = true; return [childId]; }
    return [];
  };
  child.getLocalAlternateVersionIds = async () => selected ? [ownerId] : [];
  const reload = async reference => reference === ownerId ? owner : child;
  owner.reloadMetadataContext = child.reloadMetadataContext = reload;
  const saver = { name: 'Control', isEnabledFor: () => true, validateSave: async () => {},
    save: async item => { effects.push(['saver', item.Id]); } };
  const updates = new MetadataUpdateHost({ registry: { discover: () => [saver] },
    images: { updateImages: async loaded => { effects.push(['images', loaded.item.Id]); } } });
  await assert.rejects(updates.update(owner, { Item: owner.item, Images: [] }, 16, {
    persist: async () => { committed = true; effects.push(['commit', ownerId]); }
  }), { code: 'metadata-conflict', status: 409 });
  assert.deepEqual(effects, [['saver', ownerId], ['images', ownerId], ['commit', ownerId]]);
});

test('an independent remote-image save retains the active version ancestors', async () => {
  const ownerId = 'a7180000-0000-0000-0000-000000000041', childId = 'a7180000-0000-0000-0000-000000000042';
  const effects = []; let committed = false, selected = false, converted = false;
  const owner = { dispose: async () => {}, item: nativeItem('Movie', { Id: ownerId, IsFileProtocol: true }), context: { images: [] },
    libraryOptions: { MetadataSavers: ['Control'] } };
  const child = { dispose: async () => {}, item: nativeItem('Movie', { Id: childId, IsFileProtocol: true }), context: { images: [] },
    libraryOptions: { MetadataSavers: ['Control'] } };
  owner.getLocalAlternateVersionIds = async prospective => {
    if (!committed) return [childId];
    if (!prospective && !selected) { selected = true; return [childId]; }
    return [];
  };
  child.getLocalAlternateVersionIds = async () => converted ? [ownerId] : [];
  owner.reloadMetadataContext = child.reloadMetadataContext = async reference => reference === ownerId ? owner : child;
  const saver = { name: 'Control', isEnabledFor: () => true, validateSave: async () => {},
    save: async item => { effects.push(['saver', item.Id]); } };
  class ControlledUpdates extends MetadataUpdateHost {
    update(loaded, result, reason, options = {}) {
      return super.update(loaded, result, reason, { ...options, persistImages: async () => {}, persist: async () => {
        if (loaded.item.Id === ownerId) committed = true;
        effects.push(['commit', loaded.item.Id]);
      } });
    }
  }
  const updates = new ControlledUpdates({ registry: { discover: () => [saver] },
    images: { updateImages: async loaded => {
      effects.push(['images', loaded.item.Id]);
      if (loaded.item.Id === childId && !converted) {
        converted = true;
        await loaded.onImageRemoteChange();
      }
    } } });
  await assert.rejects(updates.update(owner, { Item: owner.item, Images: [] }, 16), { code: 'metadata-conflict', status: 409 });
  assert.deepEqual(effects, [['saver', ownerId], ['images', ownerId], ['commit', ownerId], ['saver', childId], ['images', childId]]);
});

const ids = { owner: '98b90000-0000-0000-0000-000000000001', alternate: '98b90000-0000-0000-0000-000000000002',
  second: '98b90000-0000-0000-0000-000000000003', other: '98b90000-0000-0000-0000-000000000004' };
async function seedFamily(fixture, { nullValues = false, second = false } = {}) {
  // Prepare the fixture backend before declaring its isolated writable mount.
  await fixture.adapter.mkdir('/aggregate');
  fixture.vfs.mount({ path: '/fixture/aggregate', root: '/aggregate', instanceId: 'fixture',
    capabilities: { create: true, replace: true, delete: true, mkdir: true } });
  await fixture.seed({ target: 'owner', items: [
    { key: 'owner', type: 'Movie', Id: ids.owner, Name: 'Primary', Path: 'Z:\\ChildrenMetadata\\Film.mkv', IsInMixedFolder: true,
      LocalAlternateVersions: ['Z:\\ChildrenMetadata\\Film 1080p.mkv', ...(second ? ['Z:\\ChildrenMetadata\\Film 720p.mkv'] : [])],
      Genres: nullValues ? [] : ['Drama'], Overview: nullValues ? null : 'Primary overview',
      ProductionYear: nullValues ? null : 2025, PremiereDate: nullValues ? null : '2025-01-01T00:00:00.0000001Z',
      CommunityRating: nullValues ? null : 7.5, OfficialRating: nullValues ? null : 'PG', ProviderIds: nullValues ? {} : { Tmdb: '101', tmdb: '102' } },
    { key: 'alternate', type: 'Movie', Id: ids.alternate, OwnerId: ids.owner, PrimaryVersionId: ids.owner,
      Name: 'Locked version', Path: 'Z:\\ChildrenMetadata\\Film 1080p.mkv', IsInMixedFolder: true,
      Genres: ['Comedy'], Overview: 'Old version', ProductionYear: 1990, PremiereDate: '1990-01-01T00:00:00Z',
      CommunityRating: 4, OfficialRating: 'R', ProviderIds: { Imdb: 'tt202' }, Studios: ['Keep studio'], Tags: ['Keep tag'],
      CriticRating: 22, CustomRating: 'Keep custom', OriginalTitle: 'Keep original', RunTimeTicks: 9007199254740995n,
      IsLocked: true, LockedFields: ['Overview', 'Genres'] },
    ...(second ? [{ key: 'second', type: 'Movie', Id: ids.second, Name: 'Second', Path: 'Z:\\ChildrenMetadata\\Film 720p.mkv',
      OwnerId: ids.owner, PrimaryVersionId: ids.owner, IsInMixedFolder: true, Overview: 'Old second' }] : [])
  ] });
  await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: ids.alternate, ChildType: 2, SortOrder: 0 });
  if (second) await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: ids.second, ChildType: 2, SortOrder: 1 });
}
const row = async (fixture, Id) => (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
const fileText = async (vfs, filename) => {
  const handle = await vfs.openRead(filename);
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
  finally { await handle.close(); }
};
const wireSaver = (fixture, saver) => {
  fixture.registry.register({ id: 'repository-saver', name: 'RepositorySaver', providers: [{ id: 'repository-saver', name: 'RepositorySaver',
    kind: 'saver', itemTypes: ['Movie'], isEnabledFor: () => true, validateSave: async () => {}, ...saver }] });
  const original = fixture.loadContext;
  const load = async reference => { const loaded = await original(reference); loaded.libraryOptions.MetadataSavers = ['RepositorySaver'];
    loaded.reloadMetadataContext = load; return loaded; };
  fixture.loadContext = fixture.host.loadContext = load;
};

for (const dialect of ['postgres']) {
  const databaseTest = (name, run) => test(`${dialect}: ${name}`, run);
  databaseTest('repository propagation persists copied fields, independent images and unchanged child locks/credits', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    const events = []; fixture.host.updates.on('ItemUpdated', event => events.push({ id: event.Item.Id, reason: event.UpdateReason }));
    const phases = [];
    wireSaver(fixture, { save: async item => { phases.push({ id: item.Id, overview: item.Overview }); } });
    const loaded = await fixture.loadContext(ids.owner);
    const poster = { Type: 'Primary', Path: 'https://fixture.invalid/poster.png', Width: 80, Height: 60 };
    fixture.host.updates.images.updateImages = async (context, images, { forceUpdate, signal, persistImages }) => {
      phases.push({ image: context.item.Id, forceUpdate, hasSignal: signal != null });
      await persistImages(images);
    };
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, Images: [poster], People: [] }, ItemUpdateType.MetadataEdit);
    const child = await fixture.loadContext(ids.alternate);
    for (const field of ['Genres', 'Overview', 'ProductionYear', 'CommunityRating', 'OfficialRating', 'ProviderIds']) assert.deepEqual(child.item[field], loaded.item[field], field);
    assert.equal(dateText(child.item.PremiereDate), dateText(loaded.item.PremiereDate));
    for (const [field, value] of Object.entries({ Name: 'Locked version', Studios: ['Keep studio'], Tags: ['Keep tag'], CriticRating: 22,
      CustomRating: 'Keep custom', OriginalTitle: 'Keep original', RunTimeTicks: 9007199254740995n, IsLocked: true, LockedFields: ['Genres', 'Overview'] })) {
      assert.deepEqual(child.item[field], value, field);
    }
    assert.deepEqual(events, [{ id: ids.owner, reason: 16 }, { id: ids.alternate, reason: 8 }]);
    assert.deepEqual(phases, [{ id: ids.owner, overview: 'Primary overview' }, { image: ids.owner, forceUpdate: true, hasSignal: false },
      { id: ids.alternate, overview: 'Primary overview' }, { image: ids.alternate, forceUpdate: true, hasSignal: false }]);
    const ownerImages = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: ids.owner } });
    const childImages = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: ids.alternate } });
    assert.equal(childImages.length, 1); assert.equal(childImages[0].Path, poster.Path);
    assert.notEqual(childImages[0].Id, ownerImages[0].Id);
    assert.equal((await fixture.database.rows('PeopleBaseItemMap', { where: { ItemId: ids.alternate } })).length, 0);
  });
  databaseTest('repository propagation clears nullable dates and empty metadata rather than using owned date-only inheritance', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { nullValues: true });
    const loaded = await fixture.loadContext(ids.owner);
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 1);
    const child = (await fixture.loadContext(ids.alternate)).item;
    for (const field of ['Overview', 'ProductionYear', 'PremiereDate', 'CommunityRating', 'OfficialRating']) assert.equal(child[field], null, field);
    assert.deepEqual(child.Genres, []); assert.deepEqual(child.ProviderIds, {});
    assert.equal(child.RunTimeTicks, 9007199254740995n);
  });
  databaseTest('prospective local versions are linked and propagated even before a stored ChildType=2 exists', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { second: true });
    await fixture.database.delete('LinkedChildren', { ParentId: ids.owner, SortOrder: 1 });
    const loaded = await fixture.loadContext(ids.owner), events = [];
    assert.deepEqual(await loaded.getLocalAlternateVersionIds(), [ids.alternate]);
    fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 16);
    assert.deepEqual(await loaded.getLocalAlternateVersionIds(), [ids.alternate, ids.second]);
    assert.deepEqual(events, [ids.owner, ids.alternate, ids.second]);
    assert.equal((await row(fixture, ids.second)).Overview, 'Primary overview');
  });
  databaseTest('a prospective read-only version rejects before parent NFO/images or a new relationship commit', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { second: true });
    await fixture.database.delete('LinkedChildren', { ParentId: ids.owner, SortOrder: 1 });
    fixture.vfs.mount({ path: '/prospective-readonly', instanceId: 'fixture',
      capabilities: { create: false, replace: false, delete: false } });
    fixture.identityMap.addPrefix({ identityRoot: 'Z:\\ProspectiveReadOnly', accessRoot: '/prospective-readonly',
      style: 'windows', returnAccess: 'prospective repository control' });
    const readonlyPath = 'Z:\\ProspectiveReadOnly\\Film 720p.mkv';
    await fixture.database.update('BaseItems', { Id: ids.second }, { Path: readonlyPath });
    fixture.registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs: fixture.vfs }));
    const original = fixture.loadContext;
    const load = async reference => { const loaded = await original(reference); loaded.libraryOptions.MetadataSavers = ['Nfo'];
      loaded.reloadMetadataContext = load; return loaded; };
    const loaded = await load(ids.owner); loaded.item.LocalAlternateVersions[1] = readonlyPath;
    const before = await fixture.database.rows('BaseItems'), beforeLinks = await fixture.database.rows('LinkedChildren');
    let effects = 0; fixture.host.updates.on('ItemUpdated', () => { effects++; });
    fixture.host.images.updateImages = async () => { effects++; };
    assert.equal(fixture.vfs.capabilities('/fixture/aggregate/Film.nfo').create, true);
    await assert.rejects(saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, Images: [] }, 16),
      error => error.code === 'read-only' || error.code === 'not-supported');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await fixture.database.rows('LinkedChildren'), beforeLinks);
    assert.equal(effects, 0);
    await assert.rejects(fixture.vfs.stat('/fixture/aggregate/Film.nfo'), { code: 'not-found' });
  });
  databaseTest('metadata context hydrates linked versions from typed DB rows rather than serialized runtime fields', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { second: true });
    await fixture.database.update('LinkedChildren', { ParentId: ids.owner, SortOrder: 1 }, { ChildType: 3 });
    const stored = await row(fixture, ids.owner), data = parseLosslessJson(stored.Data);
    data.LinkedAlternateVersions = [{ ItemId: ids.other, Type: 2 }];
    await fixture.database.update('BaseItems', { Id: ids.owner }, { Data: JSON.stringify(data) });
    const loaded = await fixture.loadContext(ids.owner);
    assert.deepEqual(loaded.item.LinkedAlternateVersions, [{ ItemId: ids.second, Type: 3 }]);
    loaded.item.LocalAlternateVersions = [loaded.item.LocalAlternateVersions[0]];
    const events = []; fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 16);
    assert.deepEqual(events, [ids.owner, ids.alternate]);
    assert.deepEqual((await fixture.database.rows('LinkedChildren', { where: { ParentId: ids.owner },
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => [row.ChildId, row.ChildType]),
    [[ids.alternate, 2], [ids.second, 3]]);
    assert.equal((await row(fixture, ids.second)).Overview, 'Old second');
  });
  databaseTest('the ID getter retains stored local duplicates while SaveItems rebuilds and deduplicates before propagation', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { second: true });
    await fixture.database.update('LinkedChildren', { ParentId: ids.owner, SortOrder: 0 }, { ChildType: 3 });
    await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: ids.alternate, ChildType: 0, SortOrder: 3 });
    await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: ids.second, ChildType: 2, SortOrder: 2 });
    const events = []; fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    const loaded = await fixture.loadContext(ids.owner);
    assert.deepEqual(await loaded.getLocalAlternateVersionIds(), [ids.second, ids.second]);
    loaded.item.LocalAlternateVersions = ['Z:\\ChildrenMetadata\\Film 720p.mkv', 'Z:\\ChildrenMetadata\\Film 720p.mkv'];
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 4);
    assert.deepEqual(events, [ids.owner, ids.second]);
    assert.deepEqual(await loaded.getLocalAlternateVersionIds(), [ids.second]);
    assert.deepEqual((await fixture.database.rows('LinkedChildren', { where: { ParentId: ids.owner },
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => [row.ChildId, row.ChildType, row.SortOrder]),
    [[ids.second, 2, 0], [ids.alternate, 3, 1], [ids.alternate, 0, 3]]);
    assert.equal((await fixture.loadContext(ids.alternate)).item.Overview, 'Old version');
  });
  databaseTest('a failed child SQL save retains parent/earlier-child commits and events but skips parent reattachment and people', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture, { second: true });
    const before = await row(fixture, ids.second), events = [], phases = [];
    fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    fixture.host.updates.reattach = async () => { phases.push('reattach'); return []; };
    fixture.host.updates.updatePeople = async () => { phases.push('people'); };
    const original = fixture.database.update.bind(fixture.database);
    fixture.database.update = async (table, where, changes) => {
      if (table === 'BaseItems' && where.Id === ids.second) return original(table, where, { ...changes, Type: null });
      return original(table, where, changes);
    };
    const loaded = await fixture.loadContext(ids.owner); loaded.item.Overview = 'Committed new overview';
    await assert.rejects(saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, People: [] }, 16, { reattachUserData: true }), /null|constraint|not-null/iu);
    assert.equal((await row(fixture, ids.owner)).Overview, 'Committed new overview');
    assert.equal((await row(fixture, ids.alternate)).Overview, 'Committed new overview');
    assert.deepEqual(await row(fixture, ids.second), before);
    assert.deepEqual(events, [ids.owner, ids.alternate]); assert.deepEqual(phases, []);
  });
  databaseTest('an enabled alternate saver rejects its read-only VFS before parent saver/probe/image/DB or people effects', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    fixture.vfs.mount({ path: '/readonly', instanceId: 'fixture', capabilities: { create: false, replace: false, delete: false } });
    assert.equal(fixture.vfs.capabilities('/fixture/aggregate/Film.nfo').create, true);
    assert.equal(fixture.vfs.capabilities('/readonly/Film 1080p.nfo').create, false);
    fixture.identityMap.addPrefix({ identityRoot: 'Z:\\ReadOnly', accessRoot: '/readonly', style: 'windows', returnAccess: 'read-only repository control' });
    await fixture.database.update('BaseItems', { Id: ids.alternate }, { Path: 'Z:\\ReadOnly\\Film 1080p.mkv' });
    fixture.registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs: fixture.vfs }));
    const original = fixture.loadContext;
    const load = async reference => { const loaded = await original(reference); loaded.libraryOptions.MetadataSavers = ['Nfo']; loaded.reloadMetadataContext = load; return loaded; };
    fixture.loadContext = fixture.host.loadContext = load;
    let effects = 0; fixture.host.updates.on('ItemUpdated', () => effects++);
    fixture.host.images.updateImages = async () => { effects++; };
    fixture.host.probe = { supportsMetadata: () => true, refreshMetadata: async () => { effects++; return { changed: false }; } };
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.refresh(ids.owner, { MetadataRefreshMode: 'FullRefresh' }), error => error.code === 'read-only' || error.code === 'not-supported');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.equal(effects, 0);
    await assert.rejects(fixture.vfs.stat('/fixture/aggregate/Film.nfo'), { code: 'not-found' });
    fixture.host.updates.updatePeople = async () => { effects++; };
    const edits = new MetadataEditService({ library: fixture.library, loadContext: load, updates: fixture.host.updates });
    t.after(() => edits.close());
    await assert.rejects(edits.update(ids.owner, { Overview: 'Rejected edit', People: [{ Name: 'Rejected actor', Type: 'Actor' }] }),
      error => error.code === 'read-only' || error.code === 'not-supported');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.equal(effects, 0);
  });
  databaseTest('cyclic local-version links reject before any independent parent commit', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    await fixture.database.insert('LinkedChildren', { ParentId: ids.alternate, ChildId: ids.owner, ChildType: 2, SortOrder: 0 });
    const before = await fixture.database.rows('BaseItems');
    const loaded = await fixture.loadContext(ids.owner);
    await assert.rejects(saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 16), { code: 'metadata-conflict', status: 409 });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  });
  databaseTest('an existing version without an identity mapping is not silently treated as a missing DB row', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    await fixture.database.update('BaseItems', { Id: ids.alternate }, { Path: 'Y:\\UnmappedVersion\\Film.mkv' });
    const before = await fixture.database.rows('BaseItems'); let effects = 0;
    fixture.host.updates.on('ItemUpdated', () => { effects++; });
    fixture.host.images.updateImages = async () => { effects++; };
    const loaded = await fixture.loadContext(ids.owner); loaded.item.Overview = 'Must not commit';
    await assert.rejects(saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, Images: [] }, 16), { code: 'not-found' });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal(effects, 0);
  });
  databaseTest('post-parent selection sees links removed at the committed ItemUpdated boundary', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    const events = []; let linkMutation;
    fixture.host.updates.on('ItemUpdated', event => {
      events.push(event.Item.Id);
      if (event.Item.Id === ids.owner) linkMutation = fixture.database.delete('LinkedChildren', { ParentId: ids.owner, SortOrder: 0 });
    });
    // Await the event's explicit relation mutation at the controlled query
    // entry; production notification methods remain synchronous.
    const loaded = await fixture.loadContext(ids.owner), getIds = loaded.getLocalAlternateVersionIds;
    loaded.getLocalAlternateVersionIds = async () => { await linkMutation; return getIds(); };
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 16);
    assert.deepEqual(events, [ids.owner]);
    assert.equal((await fixture.loadContext(ids.alternate)).item.Overview, 'Old version');
  });
  databaseTest('cancellation after parent commit retains uncancelled child saver/image writes but not its repository or event', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    const cancellation = new AbortController(), phases = [], before = await row(fixture, ids.alternate);
    wireSaver(fixture, { save: async (item, context) => { assert.equal(context.signal, undefined); phases.push({ saver: item.Id }); } });
    fixture.host.updates.on('ItemUpdated', event => {
      phases.push({ event: event.Item.Id });
      if (event.Item.Id === ids.owner) cancellation.abort(new Error('Cancel after parent'));
    });
    const oldImage = { Id: '98b90000-0000-0000-0000-000000000011', ItemId: ids.alternate, ImageType: 2,
      Path: 'https://fixture.invalid/old.png', Width: 1, Height: 1, DateModified: '0001-01-01 00:00:00', Blurhash: null };
    await fixture.database.insert('BaseItemImageInfos', oldImage);
    fixture.host.updates.images.updateImages = async (loaded, images, options) => {
      phases.push({ image: loaded.item.Id, hasSignal: options.signal != null });
      await options.persistImages(images);
    };
    const loaded = await fixture.loadContext(ids.owner); loaded.item.Overview = 'Saved before cancellation';
    await assert.rejects(saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, Images: [] }, 16,
      { signal: cancellation.signal }), /Cancel after parent/u);
    assert.equal((await row(fixture, ids.owner)).Overview, 'Saved before cancellation');
    assert.deepEqual(await row(fixture, ids.alternate), before);
    assert.deepEqual(await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: ids.alternate } }), []);
    assert.deepEqual(phases, [{ saver: ids.owner }, { image: ids.owner, hasSignal: false }, { event: ids.owner },
      { saver: ids.alternate }, { image: ids.alternate, hasSignal: false }]);
  });
  databaseTest('a child saver runtime failure logs and continues the independent repository update', async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    const errors = [], events = [];
    fixture.host.updates.logger = { error: error => errors.push(error.message) };
    wireSaver(fixture, { save: async item => { if (item.Id === ids.alternate) throw new Error('Injected alternate saver failure'); } });
    fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    const loaded = await fixture.loadContext(ids.owner);
    await saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item }, 16);
    assert.deepEqual(events, [ids.owner, ids.alternate]);
    assert.equal((await row(fixture, ids.alternate)).Overview, 'Primary overview');
    assert.deepEqual(errors, ['Injected alternate saver failure']);
  });
  for (const failChild of [false, true]) databaseTest(`real NFO files precede each version repository${failChild ? ' and survive a failed child SQL save' : ' without replacing child identity'}`, async t => {
    const fixture = await setupChildrenFixture(t, dialect); await seedFamily(fixture);
    fixture.registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs: fixture.vfs }));
    const original = fixture.loadContext;
    const load = async reference => { const loaded = await original(reference); loaded.libraryOptions.MetadataSavers = ['Nfo']; loaded.reloadMetadataContext = load; return loaded; };
    fixture.loadContext = fixture.host.loadContext = load;
    const databaseUpdate = fixture.database.update.bind(fixture.database), saved = [], events = [];
    fixture.database.update = async (table, where, changes) => {
      if (table === 'BaseItems' && [ids.owner, ids.alternate].includes(where.Id)) {
        const filename = where.Id === ids.owner ? 'Film.nfo' : 'Film 1080p.nfo';
        saved.push({ id: where.Id, text: await fileText(fixture.vfs, '/fixture/aggregate/' + filename) });
        if (failChild && where.Id === ids.alternate) return databaseUpdate(table, where, { ...changes, Type: null });
      }
      return databaseUpdate(table, where, changes);
    };
    fixture.host.updates.on('ItemUpdated', event => events.push(event.Item.Id));
    const before = await row(fixture, ids.alternate), loaded = await load(ids.owner);
    loaded.item.Overview = 'Repository family NFO';
    const operation = saveMetadataItem(fixture.host.updates, loaded, { Item: loaded.item, Images: [] }, 16);
    if (failChild) await assert.rejects(operation, /null|constraint|not-null/iu); else await operation;
    assert.deepEqual(saved.map(value => value.id), [ids.owner, ids.alternate]);
    for (const savedFile of saved) assert.match(savedFile.text, /<plot>Repository family NFO<\/plot>/u);
    assert.match(saved[0].text, /<title>Primary<\/title>/u);
    assert.match(saved[1].text, /<title>Locked version<\/title>/u);
    assert.match(await fileText(fixture.vfs, '/fixture/aggregate/Film 1080p.nfo'), /<plot>Repository family NFO<\/plot>/u);
    assert.deepEqual(events, failChild ? [ids.owner] : [ids.owner, ids.alternate]);
    if (failChild) assert.deepEqual(await row(fixture, ids.alternate), before);
    else assert.equal((await row(fixture, ids.alternate)).Overview, 'Repository family NFO');
  });
}
