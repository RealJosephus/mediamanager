import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { itemsDispatch } from '../../src/library/items-dispatch.js';
import { boxSetLibraryFolderIds, collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { parentalAllowed, visibleItem } from '../../src/library/permissions.js';
import { parseQuery } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/boxset-dispatch/input.json', import.meta.url), 'utf8'));
const options = { programDataPath: 'C:\\state', configuration: { MetadataCountryCode: 'US' } };
const policy = { EnableAllFolders: true, EnabledFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], MaxParentalRating: null };
const user = { Policy: policy };
const nativeType = type => ['Movie', 'BoxSet'].includes(type) ? `MediaBrowser.Controller.Entities.Movies.${type}`
  : `MediaBrowser.Controller.Entities.${type}`;
async function scenario(t) {
  const rows = fixture.items.map(item => {
    const data = { ...(item.data ?? {}) };
    if (item.type === 'CollectionFolder') data.PhysicalLocationsList = [item.key === 'libraryA' ? 'C:\\mediaA'
      : item.key === 'libraryB' ? 'C:\\mediaB' : 'C:\\state\\data\\collections'];
    const locations = { physicalA: 'C:\\mediaA', physicalB: 'C:\\mediaB', collections: 'C:\\state\\data\\collections' };
    const path = locations[item.key] ?? (item.type === 'BoxSet' ? `C:\\state\\data\\collections\\${item.key}`
      : item.key.startsWith('movieA') ? `C:\\mediaA\\${item.key}.mkv` : `C:\\mediaB\\${item.key}.mkv`);
    return { Id: item.id, Type: nativeType(item.type), ParentId: item.parentId,
      TopParentId: item.topParentId, Name: item.name, SortName: item.sortName, Path: path,
      IsFolder: item.type !== 'Movie', IsMovie: item.type === 'Movie', UnratedType: item.type === 'Movie' ? 'Movie' : 'Other',
      OfficialRating: item.officialRating, InheritedParentalRatingValue: item.inheritedParentalRatingValue,
      Tags: item.tagsText, Data: JSON.stringify(data) };
  });
  const tables = { BaseItems: rows, AncestorIds: fixture.items.flatMap(item => item.ancestorIds
    .map(id => ({ ItemId: item.id, ParentItemId: id }))), LinkedChildren: fixture.links.map(link => ({
    ParentId: link.parentId, ChildId: link.childId, ChildType: link.childType, SortOrder: link.sortOrder,
  })) };
  const value = await setupChildrenFixture(t), { database, library } = value;
  Object.assign(value.configuration, options.configuration);
  Object.assign(library.options, { programDataPath: options.programDataPath,
    userRoot: rows.find(row => row.Type === nativeType('UserRootFolder')) });
  for (const [table, records] of Object.entries(tables)) {
    await database.insertBatch(table, records.map(row => postgresTestRow(table, row)));
  }
  const state = await value.state();
  state.rowsFor = () => [];
  state.valuesFor = (item, type) => fixture.itemValueLinks.filter(link => link.itemKey === fixture.items.find(row => idKey(row.id) === idKey(item.Id)).key)
    .map(link => fixture.itemValues.find(value => value.key === link.valueKey)).filter(value => value.type === type).map(value => value.cleanValue);
  const get = key => state.byId.get(idKey(fixture.items.find(item => item.key === key).id));
  const source = createMetadataChildren(value);
  const linkedAncestors = async ids => {
    const page = await queryPostgresItemPage(database, { ids: state.items.map(item => item.Id) }, {
      scope: { linkedChildAncestorIds: ids }, includeOwnedItems: true, includeAlternateVersions: true,
    });
    const selected = new Set(page.rows.map(row => idKey(row.Id)));
    return state.items.filter(item => selected.has(idKey(item.Id)));
  };
  const standaloneVisible = async (item, currentUser) => {
    try { return await library.withItemRecord(item.Id, { user: { Id: fixture.userId, ...currentUser } }, () => true); }
    catch (error) { if (error.status === 404) return false; throw error; }
  };
  return { state, get, source, creator: library.itemCreation, linkedAncestors, standaloneVisible };
}

test('container selectors rewrite the parent before access checks and retain the original linked ancestor', async t => {
  const { state, get } = await scenario(t);
  const query = parseQuery({ ParentId: get('physicalA').Id, IncludeItemTypes: 'BoxSet', Recursive: false });
  const dispatch = itemsDispatch(query, get('physicalA'), state, user);
  assert.equal(dispatch.accessItem, get('userRoot'));
  assert.equal(query.parentid, undefined);
  assert.deepEqual(dispatch.linkedChildAncestorIds, [get('physicalA').Id]);
  assert.equal(dispatch.repository, true);
  assert.equal(dispatch.postFilter, true);
  assert.deepEqual(itemsDispatch(parseQuery({ IncludeItemTypes: 'BoxSet' }), get('collectionLibrary'), state, user).linkedChildAncestorIds, []);
  assert.equal(itemsDispatch(parseQuery({ IncludeItemTypes: 'BoxSet' }), get('setA'), state, user).accessItem, get('setA'));
});

test('collection defaults infer BoxSet recursion without overriding explicit memory or movie requests', async t => {
  const { state, get } = await scenario(t);
  const inferred = parseQuery({});
  assert.equal(itemsDispatch(inferred, get('collectionLibrary'), state, user).postFilter, true);
  assert.deepEqual(inferred.includeitemtypes, ['BoxSet']);
  assert.equal(inferred.recursive, true);
  const memory = itemsDispatch(parseQuery({ Recursive: false }), get('collectionLibrary'), state, user);
  assert.equal(memory.repository, false);
  const movies = parseQuery({ IncludeItemTypes: 'Movie' });
  assert.equal(itemsDispatch(movies, get('collectionLibrary'), state, user).repository, true);
  assert.deepEqual(movies.includeitemtypes, ['Movie']);
});

test('default BoxSet views delegate but moviecollection and explicit IDs bypass entity post filtering', async t => {
  const { state, get } = await scenario(t);
  const view = itemsDispatch(parseQuery({ Recursive: true }), get('boxsetView'), state, user);
  assert.equal(view.parent, get('collectionLibrary'));
  assert.equal(view.postFilter, false);
  const direct = itemsDispatch(parseQuery({}), get('movieCollectionView'), state, user);
  assert.equal(direct.directRepository, true);
  assert.equal(direct.parent, get('userRoot'));
  assert.equal(direct.postFilter, false);
  const ids = itemsDispatch(parseQuery({ IncludeItemTypes: 'BoxSet', Ids: get('setA').Id }), get('collectionLibrary'), state, user);
  assert.equal(ids.postFilter, false);
  const anonymous = itemsDispatch(parseQuery({ IncludeItemTypes: 'BoxSet', Recursive: true }), null, state, null);
  assert.equal(anonymous.isUserRoot, true);
});

test('linked ancestor selection uses all link types, stored ancestor rows and only one linked hop', async t => {
  const { get, linkedAncestors } = await scenario(t);
  const selected = await linkedAncestors([get('physicalA').Id]);
  assert.ok(selected.includes(get('setNonmanual')));
  assert.ok(!selected.includes(get('setNested')));
  assert.deepEqual(await linkedAncestors([get('libraryA').Id]), [get('setStoredLibraryAncestor')]);
});

test('library affiliation climbs parents and owners and compares exact ordinal-ignore-case paths', async t => {
  const { state, get } = await scenario(t);
  get('physicalA').Path = 'c:\\MEDIAa';
  assert.deepEqual(collectionFoldersForItem(get('movieASub'), state), [get('libraryA')]);
  get('physicalA').Path = 'C:/mediaA';
  assert.deepEqual(collectionFoldersForItem(get('movieA'), state), []);
  get('physicalA').Path = 'C:\\mediaA';
  get('movieUnknownLibrary').OwnerId = get('movieA').Id;
  assert.deepEqual(collectionFoldersForItem(get('movieUnknownLibrary'), state), [get('libraryA')]);
});

test('nested library membership terminates cycles and honors explicitly cached library IDs', async t => {
  const { state, get, source, creator } = await scenario(t);
  const item = await creator.getItemById(get('setCycleA').Id);
  assert.deepEqual(await source.libraryFolderIds(item), [get('libraryB').Id]);
  item.LibraryFolderIds = [];
  assert.deepEqual(boxSetLibraryFolderIds(item, state), []);
  item.LibraryFolderIds = [get('libraryA').Id];
  assert.deepEqual(boxSetLibraryFolderIds(item, state), [get('libraryA').Id]);
});

test('modern collections use linked member libraries and allow unknown affiliation before child rating checks', async t => {
  const { state, get, standaloneVisible } = await scenario(t);
  const restricted = { Policy: { ...policy, EnableAllFolders: false, EnabledFolders: [get('libraryA').Id] } };
  assert.equal(await standaloneVisible(get('setA'), restricted), true);
  assert.equal(await standaloneVisible(get('setB'), restricted), false);
  assert.equal(await standaloneVisible(get('setNested'), restricted), false);
  restricted.Policy.MaxParentalRating = 6;
  assert.equal(await standaloneVisible(get('setUnknown'), restricted), true);
  assert.equal(visibleItem(get('setB'), restricted, state, options), true);
});

test('direct collection checks inspect nonmanual member ratings and use the Movie unrated override', async t => {
  const { state, get, standaloneVisible } = await scenario(t);
  const rated = { Policy: { ...policy, MaxParentalRating: 6 } };
  assert.equal(parentalAllowed(get('movieARestricted'), rated, state, options), false);
  assert.equal(await standaloneVisible(get('setNonmanual'), rated), false);
  assert.equal(visibleItem(get('setNonmanual'), rated, state, options), true);
  const unrated = { Policy: { ...policy, BlockUnratedItems: ['Movie'] } };
  assert.equal(await standaloneVisible(get('setEmpty'), unrated), false);
  assert.equal(visibleItem(get('setEmpty'), unrated, state, options), true);
});
