import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import { loadPostgresNavigationRows } from '../../src/library/postgres-library-query.js';
import assert from 'node:assert/strict';
import { getNewItemId } from '../../src/core/identity.js';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import {ItemCreationService} from '../../src/library/item-creation-service.js';
import {createMetadataContextLoader} from '../../src/library/metadata-context.js';
import { nativeUserSubviewIdentity, nativeUserViewIdentity, nativeShadowViewIdentity, nativeRootUserViewIdentity } from '../../src/library/identity.js';
import { dateText, dateTicks, EMPTY_ID, idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { userViewLabel } from '../../src/library/user-view-labels.js';

const id = number => `98000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const ids = { root: id(1), aggregate: id(2), collection: id(3), physical: id(4), view: id(5), user: id(999) };
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column =>
  [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const record = (Id, Type, Name, values = {}) => ({ ...empty('BaseItems'), Id,
  Type: 'MediaBrowser.Controller.Entities.' + Type, Name, SortName: Name.toLowerCase(), CleanName: Name.toLowerCase(),
  IsFolder: true, Tags: '', Studios: '', Genres: '', ProductionLocations: '', MediaType: 'Unknown', UnratedType: 'Other',
  Data: '{}', ...values });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const movieNames = ['Continue Watching', 'Latest', 'Movies', 'Collections', 'Favorites', 'Genres'];
const menuTypes = ['movieresume', 'movielatest', 'moviemovies', 'moviecollection', 'moviefavorites', 'moviegenres'];
const postgresTest = (name, run) => test(name, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, run);

async function fixture(t, dialect = 'postgres') {
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-user-views-'));
  const schema = 'user_views_' + process.pid + '_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  const db = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(db);
  const linkedChildren=new PostgresLinkedChildrenStore({database:db});await linkedChildren.initialize();
  const added = [], updated = [], errors = [];
  let now = new Date(Date.now() + 60000);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'user-view-test', programDataPath: directory,
    userRoot: record(ids.root, 'UserRootFolder', 'Root'),
    configuration: { UICulture: 'en-US' }, clock: () => now, onError: error => errors.push(error) });
  const states=new Set(),load=library.load.bind(library);library.load=async(...args)=>{const state=await load(...args),dispose=state.dispose.bind(state);states.add(state);state.dispose=async options=>{try{await dispose(options);}finally{states.delete(state);}};return state;};
  const loadContext=createMetadataContextLoader({fileSystem: testFileSystem, store,library,linkedChildren,configuration:library.options.configuration});
  const itemCreation=new ItemCreationService({store,library,linkedChildren,loadContext});library.itemCreation=itemCreation;
  t.after(async () => {
    try { await library.close();for(const state of states)await state.dispose();await itemCreation.close();await linkedChildren.flushReleases();await linkedChildren.close(); }
    finally {
      try {
        await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
        await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
      } finally {
        try { await store.close(); }
        finally {
          const target = path.resolve(directory);
          assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(target).startsWith('mm-user-views-'));
          await rm(target, { recursive: true, force: false });
        }
      }
    }
  });
  library.on('ItemAdded', event => added.push(event));
  library.on('ItemUpdated', event => updated.push(event));
  await db.insert('BaseItems', record(ids.root, 'UserRootFolder', 'Root'));
  await db.insert('BaseItems', record(ids.aggregate, 'AggregateFolder', 'Aggregate'));
  await db.insert('BaseItems', record(ids.collection, 'CollectionFolder', 'Movie library', { ParentId: ids.root,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.physical] }) }));
  await db.insert('BaseItems', record(ids.physical, 'Folder', 'Physical', { ParentId: ids.aggregate, TopParentId: ids.physical }));
  await db.insert('BaseItems', record(ids.view, 'UserView', 'Imported movie view', { Path: path.join(directory, 'imported-view'),
    Data: JSON.stringify({ ViewType: 'movies', DisplayParentId: idKey(ids.collection) }) }));
  const user = { Id: ids.user, Username: 'View reader', MaxParentalRatingScore: null, MaxParentalRatingSubScore: null,
    Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] },
    Configuration: {} };
  return { db, store, directory, library, user, added, updated, errors,
    query: input => library.queryItems({ ParentId: ids.view, EnableImages: false, EnableUserData: false, ...input }),
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); },
    now: () => dateText(now.toISOString()),
    newRows: async () => (await db.rows('BaseItems')).filter(row => row.Type.endsWith('.UserView') && idKey(row.Id) !== idKey(ids.view)) };
}

test('UserView identities preserve the external 37/38 namespaces and Guid.Empty parent semantics', () => {
  const options = { programDataPath: 'Z:\\FixtureState' };
  const viewType = 'movies';
  const expectedUser = getNewItemId(`38_namedview_${idKey(ids.user)}${viewType}`, 'MediaBrowser.Controller.Entities.UserView', options);
  assert.equal(idKey(nativeUserViewIdentity(ids.user, EMPTY_ID, viewType, options).Id), idKey(expectedUser));
  const expectedShared = getNewItemId(`37_namedview_${idKey(ids.collection)}movieresume${ids.collection}subviewmovieresume`,
    'MediaBrowser.Controller.Entities.UserView', options);
  const identity = nativeUserSubviewIdentity(ids.collection, 'movieresume', options);
  assert.equal(idKey(identity.Id), idKey(expectedShared));
  assert.equal(identity.StoredPath, '%MetadataPath%\\views\\' + idKey(identity.Id));
  assert.equal(nativeUserSubviewIdentity(ids.collection.toUpperCase(), 'movieresume', options).Id, identity.Id);
  assert.notEqual(nativeUserViewIdentity(id(998), EMPTY_ID, viewType, options).Id, nativeUserViewIdentity(ids.user, EMPTY_ID, viewType, options).Id);
});

test('UserView localization uses server culture, case-insensitive keys and English fallback', () => {
  assert.equal(userViewLabel('Movies'), 'Movies');
  assert.equal(userViewLabel('mOvIeS', { configuration: { UICulture: 'zh-TW' } }), '電影');
  assert.equal(userViewLabel('Movies', { configuration: { UICulture: 'ZH-tw' } }), '電影');
  assert.equal(userViewLabel('Movies', { configuration: { UICulture: 'unsupported' } }), 'Movies');
  assert.equal(userViewLabel('UnknownView'), 'UnknownView');
});

postgresTest('global folders reads retain one identity and refresh only after creation or a localized name change', async t => {
  const { db, library, user, advance, updated } = await fixture(t);
  library.options.configuration.EnableFolderView = true;
  const first = await library.getViews({}, { user });
  const identity = nativeRootUserViewIdentity('folders', library.options);
  assert.equal(first.Items.find(item => item.CollectionType === 'folders').Id, idKey(identity.Id));
  assert.equal(first.Items.find(item => item.CollectionType === 'folders').DateLastMediaAdded, undefined,
    'a freshly created native UserView keeps its nullable folder date and the HTTP DTO omits it');
  await library.userViews.drain();
  assert.ok(updated.some(event => event.Item.Id === identity.Id && event.UpdateReason === ItemUpdateType.MetadataImport));
  const rows = await db.rows('BaseItems');
  const eventCount = updated.length;
  advance(24 * 60 * 60 * 1000);
  await library.getViews({}, { user }); await library.userViews.drain();
  assert.deepEqual(await db.rows('BaseItems'), rows);
  assert.equal(updated.length, eventCount);
  library.options.configuration.UICulture = 'zh-TW';
  const changed = await library.getViews({}, { user }); await library.userViews.drain();
  assert.equal(changed.Items.find(item => item.Id === idKey(identity.Id)).Name, userViewLabel('Folders', library.options));
  assert.ok(updated.slice(eventCount).some(event => event.UpdateReason === ItemUpdateType.MetadataImport));
  assert.equal((await db.rows('BaseItems', { where: { Id: identity.Id } })).length, 1);
  await library.close();
  const reloaded = new LibraryService({fileSystem: testFileSystem,  ...library.options, store: library.store, clock: library.clock });
  await attachLibraryNavigation(reloaded);
  try {
    const restored = await reloaded.getViews({}, { user });
    assert.equal(restored.Items.find(item => item.Id === idKey(identity.Id)).DateLastMediaAdded, MIN_DATE,
      'BaseItemMapper populates the directory date only when reading a persisted folder into a new instance');
  } finally { await closeLibraryNavigation(reloaded); }
});

test('postgres: folders view pages authorized root folders through the native in-memory query contract', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { db, library, user } = await fixture(t, 'postgres');
  const archivePhysicalId = id(6), archiveCollectionId = id(7);
  await db.insert('BaseItems', record(archivePhysicalId, 'Folder', 'Archive physical', {
    ParentId: ids.aggregate,
    TopParentId: archivePhysicalId,
  }));
  await db.insert('BaseItems', record(archiveCollectionId, 'CollectionFolder', 'Archive library', {
    ParentId: ids.root,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [archivePhysicalId] }),
  }));

  library.options.configuration.EnableFolderView = true;
  const views = await library.getViews({}, { user });
  const folders = views.Items.find(item => item.CollectionType === 'folders');
  assert.ok(folders);
  await library.userViews.drain();

  const page = await library.queryItems({
    ParentId: folders.Id,
    Recursive: true,
    SearchTerm: 'no root folder has this text',
    MinWidth: 99999,
    SortBy: 'Name',
    SortOrder: 'Descending',
    StartIndex: 1,
    Limit: 1,
    EnableTotalRecordCount: false,
    EnableImages: false,
    EnableUserData: false,
  }, { user });
  assert.deepEqual(page.Items.map(item => item.Name), ['Archive library']);
  assert.equal(page.TotalRecordCount, 2);
  assert.equal(page.StartIndex, 1);

  const unbounded = await library.queryItems({
    ParentId: folders.Id,
    Recursive: true,
    MinWidth: 99999,
    SortBy: 'Name',
    StartIndex: 1,
    Limit: 0,
    EnableImages: false,
    EnableUserData: false,
  }, { user });
  assert.deepEqual(unbounded.Items.map(item => item.Name), ['Movie library']);
  assert.equal(unbounded.TotalRecordCount, 2);
  assert.equal(unbounded.StartIndex, 1);

  const restricted = {
    ...user,
    Policy: { ...user.Policy, EnableAllFolders: false, EnabledFolders: [ids.collection] },
  };
  const visible = await library.queryItems({
    ParentId: folders.Id,
    SortBy: 'Name',
    Limit: 0,
    EnableImages: false,
    EnableUserData: false,
  }, { user: restricted });
  assert.deepEqual(visible.Items.map(item => item.Name), ['Movie library']);
  assert.equal(visible.TotalRecordCount, 1);
});

postgresTest('preset shadows share a parent directory across users and retain existing view metadata', async t => {
  const { db, library, user, directory, updated } = await fixture(t);
  const parentPath = path.join(directory, 'root', 'default', 'Books');
  const parent = (await db.rows('BaseItems', { where: { Id: ids.collection } }))[0];
  await db.upsert('BaseItems', { ...parent, Path: parentPath,
    Data: JSON.stringify({ CollectionType: 'books', PhysicalFolderIds: [ids.physical] }) });
  const first = await library.getViews({ presetViews: ['books'] }, { user });
  await library.userViews.drain();
  const identity = nativeShadowViewIdentity({ ...parent, Path: parentPath }, 'books', library.options);
  assert.equal(first.Items.find(item => item.CollectionType === 'books').Id, idKey(identity.Id));
  const stored = (await db.rows('BaseItems', { where: { Id: identity.Id } }))[0];
  assert.equal(stored.Path, parentPath);
  assert.equal(JSON.parse(stored.Data).UserId, undefined);
  await db.upsert('BaseItems', { ...stored, Name: 'Stored shadow name', ForcedSortName: 'retained' });
  const eventCount = updated.length;
  const second = await library.getViews({ presetViews: ['books'] }, { user: { ...user, Id: id(998) } });
  await library.userViews.drain();
  assert.equal(second.Items.find(item => item.Id === idKey(identity.Id)).Name, 'Stored shadow name');
  assert.equal(updated.length, eventCount);
  assert.equal((await db.rows('BaseItems', { where: { Id: identity.Id } }))[0].ForcedSortName, 'retained');
});

test('all 105 UserView culture resources reproduce the selected frozen keys and 110 source digests', async () => {
  const labels = JSON.parse(await readFile(new URL('../../src/library/resources/user-view-labels.json', import.meta.url), 'utf8'));
  const provenance = JSON.parse(await readFile(new URL('../../src/library/resources/user-view-labels-provenance.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(labels).length, 105);
  assert.equal(provenance.sourceFiles.length, 110);
  assert.equal(new Set(provenance.sourceFiles.map(value => value.path)).size, 110);
  assert.equal(provenance.license, 'GPL-2.0-only');
  const nativeBytes = await readFile(new URL('./fixtures/user-views/native-labels.json', import.meta.url));
  assert.equal(createHash('sha256').update(nativeBytes).digest('hex'), '3044a715142457e044cccfcbd51a98e2680499c55e3dc60f95b95d3fae81cb2c');
  const native = JSON.parse(nativeBytes);
  assert.equal(native.schemaVersion, 1);
  assert.deepEqual(provenance.sourceFiles, native.sourceFiles);
  assert.equal(provenance.license, native.license);
  const keys = native.keys;
  for (const source of provenance.sourceFiles) {
    if (!source.path.endsWith('.json')) continue;
    const culture = path.basename(source.path, '.json');
    const values = native.labels[culture];
    assert.deepEqual(labels[culture], Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])));
    for (const key of keys) assert.equal(userViewLabel(key, { configuration: { UICulture: culture.replaceAll('_', '-') } }),
      values[key] ?? labels['en-US'][key] ?? key, `${culture}:${key}`);
  }
});

for (const dialect of ['postgres']) test(`${dialect}: UserView creation runs the real metadata/save/event pipeline without a media VFS`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { query, db, directory, library, added, updated, errors, now, newRows } = await fixture(t, dialect);
  assert.deepEqual((await query()).Items.map(value => value.Name), movieNames);
  await library.userViews.drain();
  const rows = await newRows();
  assert.equal(rows.length, 6);
  assert.equal(added.length, 6);
  assert.equal(updated.length, 12, 'first refresh saves before providers and again after metadata processing');
  for (const [index, viewType] of menuTypes.entries()) {
    const row = rows.find(value => JSON.parse(value.Data).ViewType === viewType);
    const identity = nativeUserSubviewIdentity(ids.collection, viewType, library.options);
    assert.equal(idKey(row.Id), idKey(identity.Id));
    assert.equal(row.ForcedSortName, String(index));
    assert.equal(row.SortName, String(index).padStart(10, '0'));
    assert.equal(row.DateCreated, nativeDateFromUnixNanoseconds((await stat(identity.Path, { bigint: true })).birthtimeNs));
    assert.equal(dateText(row.DateLastRefreshed), now());
    assert.equal(dateText(row.DateLastSaved), now());
    assert.equal(dateText(JSON.parse(row.Data).DateLastSaved), now());
    assert.equal(row.DateModified, null);
    assert.equal(row.PresentationUniqueKey, idKey(row.Id));
    assert.deepEqual(updated.filter(event => event.Item.Id === row.Id).map(event => event.UpdateReason),
      [ItemUpdateType.MetadataImport, ItemUpdateType.None | ItemUpdateType.MetadataImport | ItemUpdateType.MetadataDownload]);
    assert.equal(row.Artists, null);
    assert.equal(row.AlbumArtists, null);
    assert.ok(dateTicks(row.DateCreated) <= dateTicks(row.DateLastRefreshed));
    assert.equal((await stat(path.join(directory, 'metadata/views', idKey(row.Id)))).isDirectory(), true);
    for (const table of ['BaseItemProviders', 'BaseItemMetadataFields', 'PeopleBaseItemMap', 'BaseItemImageInfos']) {
      assert.deepEqual(await db.rows(table, { where: { ItemId: row.Id } }), []);
    }
  }
  const snapshot = await db.rows('BaseItems');
  await query(); await library.userViews.drain();
  assert.deepEqual(await db.rows('BaseItems'), snapshot);
  assert.equal(added.length, 6);
  assert.equal(updated.length, 12);
  assert.deepEqual(errors, []);
});

postgresTest('UserView culture changes update the same identities and preserve stored forced sorting and display parents', async t => {
  const { query, db, library, newRows, added, updated, advance, errors } = await fixture(t);
  await query(); await library.userViews.drain();
  const before = await newRows();
  const first = before.find(row => JSON.parse(row.Data).ViewType === 'movieresume');
  await db.update('BaseItems', { Id: first.Id }, { ForcedSortName: '99' });
  advance(1000);
  library.options.configuration.UICulture = 'zh-TW';
  const translated = await query();
  await library.userViews.drain();
  assert.equal(translated.Items.find(value => value.Id === idKey(first.Id)).Name, '繼續觀看');
  const after = await newRows();
  assert.deepEqual(after.map(row => row.Id), before.map(row => row.Id));
  assert.equal(after.find(row => row.Id === first.Id).ForcedSortName, '99');
  assert.equal(JSON.parse(after.find(row => row.Id === first.Id).Data).DisplayParentId, idKey(ids.collection));
  assert.deepEqual(after.map(row => row.DateLastRefreshed), before.map(row => row.DateLastRefreshed), 'rename is a metadata edit, not a refresh');
  assert.equal(added.length, 6);
  assert.equal(updated.filter(event => event.UpdateReason === ItemUpdateType.MetadataEdit).length, 6);
  assert.deepEqual(errors, []);
});

postgresTest('UserView refresh is scheduled at exactly 24 hours or when the display parent was saved later', async t => {
  const { query, db, library, advance, now, errors } = await fixture(t);
  await query(); await library.userViews.drain();
  const refresh = library.userViews.metadata.refresh.bind(library.userViews.metadata);
  let calls = 0;
  library.userViews.metadata.refresh = (...args) => { calls++; return refresh(...args); };
  advance(86400000 - 1);
  await query(); await library.userViews.drain();
  assert.equal(calls, 0);
  advance(1);
  await query(); await library.userViews.drain();
  assert.equal(calls, 6);
  advance(1);
  await db.update('BaseItems', { Id: ids.collection }, { DateLastSaved: now().replace('T', ' ').replace(/Z$/, '') });
  await query(); await library.userViews.drain();
  assert.equal(calls, 12);
  assert.deepEqual(errors, []);
});

postgresTest('UserView refresh errors remain observable, do not stamp success and permit a later retry', async t => {
  const { query, library, newRows, added, errors } = await fixture(t);
  const refresh = library.userViews.metadata.refresh.bind(library.userViews.metadata);
  const failure = new Error('Injected UserView metadata failure');
  library.userViews.metadata.refresh = async () => { throw failure; };
  await query(); await library.userViews.drain();
  assert.equal(errors.length, 6);
  assert.ok(errors.every(error => error === failure));
  for (const row of await newRows()) {
    assert.equal(row.DateLastRefreshed, null);
    assert.equal(row.DateLastSaved, null);
    assert.equal(row.PresentationUniqueKey, null);
    assert.equal(JSON.parse(row.Data).DateLastSaved, MIN_DATE);
  }
  library.userViews.metadata.refresh = refresh;
  await query(); await library.userViews.drain();
  assert.equal(added.length, 6, 'retry does not recreate views');
  for (const row of await newRows()) assert.ok(row.DateLastRefreshed && row.DateLastSaved);
  assert.equal(errors.length, 6);
});

postgresTest('UserView disposal cancels the active refresh, stops pending work and close waits for owned resources', async t => {
  const { store, library, errors } = await fixture(t);
  const started = deferred(), gate = deferred();
  const refresh = library.userViews.metadata.refresh.bind(library.userViews.metadata);
  let calls = 0;
  library.userViews.metadata.refresh = async (...args) => {
    calls++; started.resolve(); await gate.promise; return refresh(...args);
  };
  try {
    await store.run(async db => {
      const state = await library.load(db, null, { baseRows: await loadPostgresNavigationRows(db) });
      const parent = state.byId.get(idKey(ids.collection));
      const first = await library.userViews.menu('movies', parent, db, state);
      const second = await library.userViews.menu('movies', parent, db, state);
      assert.deepEqual(first.map(item => item.Id), second.map(item => item.Id));
      assert.equal(calls, 0, 'the refresh must wait until this request leaves the connection');
    });
    await started.promise;
    library.userViews.dispose();
    let closed = false;
    const closing = library.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    gate.resolve();
    await closing;
    assert.equal(calls, 1, 'native disposal stops before taking any pending entry');
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); }
});

postgresTest('UserView repeated menus enqueue each identity separately after leaving the request scope', async t => {
  const { store, library, errors } = await fixture(t);
  const calls = [];
  library.userViews.metadata.refresh = async itemId => { calls.push(itemId); };
  await store.run(async db => {
    const state = await library.load(db, null, { baseRows: await loadPostgresNavigationRows(db) });
    const parent = state.byId.get(idKey(ids.collection));
    const first = await library.userViews.menu('movies', parent, db, state);
    for (let index = 0; index < 2; index++) {
      assert.deepEqual((await library.userViews.menu('movies', parent, db, state)).map(item => item.Id), first.map(item => item.Id));
    }
    assert.deepEqual(calls, [], 'metadata work must leave the active connection scope');
  });
  await library.userViews.drain();
  assert.equal(calls.length, 18);
  for (const viewType of menuTypes) assert.equal(calls.filter(itemId =>
    itemId === nativeUserSubviewIdentity(ids.collection, viewType, library.options).Id).length, 3);
  assert.deepEqual(errors, []);
});

postgresTest('UserView close is idempotent and rejects menu writes before creating any state', async t => {
  const { library, store, db, directory } = await fixture(t);
  const images = library.userViews.images;
  const closeImages = images.close.bind(images);
  let calls = 0;
  images.close = async () => { calls++; await closeImages(); };
  await library.close();
  await library.close();
  assert.equal(calls, 1, 'owned resources close once');
  const before = await db.rows('BaseItems');
  await assert.rejects(store.run(async connection => {
    const state = await library.load(connection, null, { baseRows: await loadPostgresNavigationRows(connection) });
    return library.userViews.menu('movies', state.byId.get(idKey(ids.collection)), connection, state);
  }), error => error.code === 'closed');
  assert.deepEqual(await db.rows('BaseItems'), before);
  await assert.rejects(stat(path.join(directory, 'metadata/views')), error => error.code === 'ENOENT');
});

postgresTest('a file occupying a UserView directory fails creation without a partial database row', async t => {
  const { query, db, library } = await fixture(t);
  const identity = nativeUserSubviewIdentity(ids.collection, 'movieresume', library.options);
  await mkdir(path.dirname(identity.Path), { recursive: true });
  await writeFile(identity.Path, 'occupied', { flag: 'wx' });
  const before = await db.rows('BaseItems');
  await assert.rejects(query(), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.deepEqual(await db.rows('BaseItems'), before);
});

postgresTest('grouped UserView roots are user-specific, hidden only after creation and respect ordered views', async t => {
  const { db, library, user, newRows, errors } = await fixture(t);
  await db.insert('BaseItems', record(id(7), 'CollectionFolder', 'Mixed library', { ParentId: ids.root, Data: JSON.stringify({
    CollectionType: null, PhysicalFolderIds: [] }) }));
  user.Configuration.GroupedFolders = [ids.collection, id(7)];
  const movieId = nativeUserViewIdentity(user.Id, EMPTY_ID, 'movies', library.options).Id;
  const tvId = nativeUserViewIdentity(user.Id, EMPTY_ID, 'tvshows', library.options).Id;
  user.Configuration.OrderedViews = [tvId, movieId];
  user.Configuration.MyMediaExcludes = [movieId];
  assert.deepEqual((await library.getViews({}, { user })).Items.map(value => value.Id), [idKey(tvId)]);
  await library.userViews.drain();
  assert.equal((await newRows()).filter(row => JSON.parse(row.Data).UserId).length, 2, 'hidden user roots are still materialized');
  assert.equal((await newRows()).filter(row => menuTypes.includes(JSON.parse(row.Data).ViewType)
    || String(JSON.parse(row.Data).ViewType).startsWith('tv')).length, 8,
  'a grouped TV view without physical sources falls back to seven child-menu views and the TV root');
  assert.deepEqual((await library.getViews({ IncludeHidden: true }, { user })).Items.map(value => value.Id), [idKey(tvId), idKey(movieId)]);
  const other = { ...user, Id: id(998), Configuration: { GroupedFolders: user.Configuration.GroupedFolders } };
  await library.getViews({}, { user: other }); await library.userViews.drain();
  assert.equal((await newRows()).filter(row => JSON.parse(row.Data).UserId).length, 4);
  assert.deepEqual(errors, []);
});
