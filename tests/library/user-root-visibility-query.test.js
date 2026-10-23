import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryService } from '../../src/library/library-service.js';
import { itemsDispatch } from '../../src/library/items-dispatch.js';
import { visibleItem } from '../../src/library/permissions.js';
import { parseQuery } from '../../src/library/query.js';
import { idKey, mapRecord } from '../../src/library/records.js';
import { cloneNativeItemEntity } from '../../src/library/native-item-entity.js';

const id = index => '90000000-0000-0000-0000-' + String(index).padStart(12, '0');
function entity({ Type, IsFolder, UnratedType, ...values }) {
  const nativeType = Type === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder'
    : Type === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie' : 'MediaBrowser.Controller.Entities.' + Type;
  const item = mapRecord({ Id: values.Id, Type: nativeType, Data: '{}', Name: values.Name,
    ParentId: values.ParentId ?? null, OwnerId: null, PrimaryVersionId: null,
    TopParentId: values.TopParentId ?? null, SortName: values.SortName ?? '', Path: values.Path ?? null });
  Object.assign(item, values);
  if (IsFolder !== undefined) assert.equal(item.IsFolder, IsFolder);
  if (UnratedType !== undefined) assert.equal(item.UnratedType, UnratedType);
  return item;
}
const changed = (item, values) => Object.assign(cloneNativeItemEntity(item), values);
const root = entity({ Id: id(1), Type: 'UserRootFolder', IsFolder: true, Tags: [] });
const collection = entity({ Id: id(2), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
  Name: 'Blocked Library', SortName: 'a', Tags: ['Library Blocked'],
  Path: 'C:\\State\\root\\default\\Library', PhysicalLocationsList: ['C:\\Media'] });
const physical = entity({ Id: id(3), Type: 'Folder', IsFolder: true, Tags: [], Path: 'C:\\Media' });
const movie = entity({ Id: id(4), Type: 'Movie', ParentId: physical.Id, TopParentId: physical.Id,
  IsFolder: false, Tags: ['Permit'], UnratedType: 'Movie' });
const account = patch => ({ Id: id(20), Policy: {
  EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
  BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], ...patch,
} });
function stateFor(items) {
  items = items.map(item => cloneNativeItemEntity(item));
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
  assert.equal(visibleItem(changed(movie, { NativeTopParentId: collection.Id }), blocked, state, sql), false);
  assert.equal(visibleItem(changed(movie, { SeriesId: collection.Id }), blocked, state, sql), false);
});

test('root grouping parents require their own IsVisible and retain folder allowed-tag/unrated exemptions', async t => {
  const highRating = entity({ Id: id(5), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Rated Library', SortName: 'b', Tags: [], OfficialRating: 'R' });
  const plain = entity({ Id: id(6), Type: 'CollectionFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Plain Library', SortName: 'c', Tags: [], UnratedType: 'Other' });
  const playlists = entity({ Id: id(7), Type: 'PlaylistsFolder', ParentId: root.Id, IsFolder: true,
    Name: 'Playlists', SortName: 'playlists', Tags: [], UnratedType: 'Other' });
  const state = stateFor([root, collection, highRating, plain, playlists]);
  const user = account({ BlockedTags: ['Library Blocked'], AllowedTags: ['Not Present'],
    MaxParentalRating: 5, BlockUnratedItems: ['Other'] });
  const library = new LibraryService({ store: {}, serverId: id(21), configuration: { MetadataCountryCode: 'US' } });
  t.after(() => library.close());
  const children = library.rootChildren(state, user);
  assert.deepEqual(children.map(item => item.Id), [plain.Id, playlists.Id]);
});

test('moviecollection SetUser(null) fails before repository dispatch, while explicit Ids bypass the builder', () => {
  const view = entity({ Id: id(8), Type: 'UserView', IsFolder: true, ViewType: 'moviecollection' });
  const state = stateFor([root, view, movie]);
  assert.throws(() => itemsDispatch(parseQuery({}), view, state, null),
    error => error.status === 500 && error.message === 'Error processing request.');
  assert.equal(itemsDispatch(parseQuery({ Ids: movie.Id }), view, state, null).repository, true);
});
