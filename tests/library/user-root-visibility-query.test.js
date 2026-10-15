import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryService } from '../../src/library/library-service.js';
import { itemsDispatch } from '../../src/library/items-dispatch.js';
import { visibleItem } from '../../src/library/permissions.js';
import { parseQuery } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';

const id = index => '90000000-0000-0000-0000-' + String(index).padStart(12, '0');
const root = { Id: id(1), Type: 'UserRootFolder', IsFolder: true, Tags: [] };
const collection = { Id: id(2), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
  Name: 'Blocked Library', SortName: 'a', Tags: ['Library Blocked'],
  Path: 'C:\\State\\root\\default\\Library', PhysicalLocationsList: ['C:\\Media'] };
const physical = { Id: id(3), Type: 'Folder', IsFolder: true, Tags: [], Path: 'C:\\Media' };
const movie = { Id: id(4), Type: 'Movie', ParentId: physical.Id, TopParentId: physical.Id,
  IsFolder: false, Tags: ['Permit'], UnratedType: 'Movie' };
const account = patch => ({ Id: id(20), Policy: {
  EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
  BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], ...patch,
} });
function stateFor(items) {
  items = items.map(item => ({ ...item }));
  return { items, byId: new Map(items.map(item => [idKey(item.Id), item])), links: [], parents: [],
    ancestors: item => item.Id === movie.Id ? [physical, collection, root] : item.Id === root.Id ? [] : [root],
    valuesFor: item => (item.Tags ?? []).map(tag => tag.toLowerCase()) };
}

test('repository tag scope uses persisted parents/top parent/series, not derived collection membership', () => {
  const state = stateFor([root, collection, physical, movie]);
  state.parents = [{ ItemId: movie.Id, ParentItemId: physical.Id }];
  const blocked = account({ BlockedTags: ['Library Blocked'] });
  const sql = { query: true, scopeLibraryFolders: false };
  const memory = { query: false, checkStandaloneParents: false };
  assert.equal(visibleItem(movie, blocked, state, sql), true);
  assert.equal(visibleItem(movie, blocked, state, memory), false);
  const allowed = account({ AllowedTags: ['Library Blocked'] });
  assert.equal(visibleItem(movie, allowed, state, sql), false);
  assert.equal(visibleItem(movie, allowed, state, memory), true);
  state.parents.push({ ItemId: movie.Id, ParentItemId: collection.Id });
  assert.equal(visibleItem(movie, blocked, state, sql), false);
  state.parents.pop();
  assert.equal(visibleItem({ ...movie, TopParentId: collection.Id }, blocked, state, sql), false);
  assert.equal(visibleItem({ ...movie, SeriesId: collection.Id }, blocked, state, sql), false);
});

test('root grouping parents require their own IsVisible and retain folder allowed-tag/unrated exemptions', () => {
  const highRating = { Id: id(5), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Rated Library', SortName: 'b', Tags: [], OfficialRating: 'R' };
  const plain = { Id: id(6), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Plain Library', SortName: 'c', Tags: [], UnratedType: 'Other' };
  const playlists = { Id: id(7), Type: 'PlaylistsFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Playlists', SortName: 'playlists', Tags: [], UnratedType: 'Other' };
  const state = stateFor([root, collection, highRating, plain, playlists]);
  const user = account({ BlockedTags: ['Library Blocked'], AllowedTags: ['Not Present'],
    MaxParentalRating: 5, BlockUnratedItems: ['Other'] });
  const children = LibraryService.prototype.rootChildren.call({ options: { configuration: { MetadataCountryCode: 'US' } } }, state, user);
  assert.deepEqual(children.map(item => item.Id), [plain.Id, playlists.Id]);
});

test('moviecollection SetUser(null) fails before repository dispatch, while explicit Ids bypass the builder', () => {
  const view = { Id: id(8), Type: 'UserView', IsFolder: true, ViewType: 'moviecollection' };
  const state = stateFor([root, view, movie]);
  assert.throws(() => itemsDispatch(parseQuery({}), view, state, null),
    error => error.status === 500 && error.message === 'Error processing request.');
  assert.equal(itemsDispatch(parseQuery({ Ids: movie.Id }), view, state, null).repository, true);
});
