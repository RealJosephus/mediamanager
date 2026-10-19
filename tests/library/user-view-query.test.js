import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { itemsDispatch } from '../../src/library/items-dispatch.js';
import { parseQuery } from '../../src/library/query.js';
import { sortName } from '../../src/library/dto.js';
import { groupedMediaFolders } from '../../src/library/user-view-query.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/user-view-query/input.json', import.meta.url), 'utf8'));
const items = fixture.items.map(row => ({ ...row.data, Id: row.id, Type: row.type, Name: row.name,
  ParentId: row.parentId, TopParentId: row.topParentId, IsFolder: !['Movie', 'Book', 'AudioBook', 'Audio', 'Episode'].includes(row.type) }));
const state = { items, byId: new Map(items.map(item => [idKey(item.Id), item])),
  parents: fixture.items.flatMap(item => item.ancestorIds.map(ParentItemId => ({ ItemId: item.id, ParentItemId }))) };
const get = key => state.byId.get(idKey(fixture.items.find(item => item.key === key).id));
const folders = items.filter(item => item.Type === 'CollectionFolder');
const user = { Id: fixture.userId, Configuration: { GroupedFolders: folders.map(item => item.Id) } };
const dispatch = (key, input = {}, account = user) => {
  const query = parseQuery(input);
  return { query, plan: itemsDispatch(query, get(key), state, account) };
};

test('UserView leaf builders override public media kinds, favorite and genre selectors', () => {
  const favorite = dispatch('moviefavorites', { IncludeItemTypes: 'Audio', IsFavorite: false, Recursive: false });
  assert.deepEqual(favorite.query.includeitemtypes, ['Movie']);
  assert.equal(favorite.query.isfavorite, true);
  assert.equal(favorite.plan.directRepository, true);
  assert.equal(favorite.plan.parent, get('libraryA'));
  const genre = dispatch('tvgenre', { GenreIds: get('moviegenre').Id });
  assert.deepEqual(genre.query.genreids, [get('tvgenre').Id]);
  assert.deepEqual(genre.query.includeitemtypes, ['Series']);
  assert.deepEqual(dispatch('books').query.includeitemtypes, ['Book', 'AudioBook']);
});

test('UserView Latest/Resume impose two descending keys, 50 rows and list-count semantics', () => {
  const latest = dispatch('tvlatest', { Limit: 0, StartIndex: 3, SortBy: 'Name', SortOrder: 'Ascending', IsMissing: true });
  assert.deepEqual(latest.query.sortby, ['DateCreated', 'SortName']);
  assert.deepEqual(latest.query.sortorder, ['Descending', 'Descending']);
  assert.equal(latest.query.limit, 50);
  assert.equal(latest.query.startindex, 3);
  assert.equal(latest.query.ismissing, false);
  assert.equal(latest.plan.pageResult, true);
  const resume = dispatch('movieresume', { Limit: 100 });
  assert.deepEqual(resume.query.sortby, ['DatePlayed', 'SortName']);
  assert.equal(resume.query.isresumable, true);
  assert.equal(resume.query.limit, 50);
});

test('UserView recursive movie/TV roots preserve explicit kinds and Folder dispatch', () => {
  const movie = dispatch('moviesRecursive', { Recursive: true });
  assert.deepEqual(movie.query.includeitemtypes, ['Movie']);
  assert.equal(movie.plan.directRepository, false);
  const tv = dispatch('tvRecursive', { Recursive: true });
  assert.deepEqual(tv.query.includeitemtypes, ['Series', 'Season', 'Episode']);
  assert.deepEqual(dispatch('moviesRecursive', { Recursive: true, IncludeItemTypes: 'Audio' }).query.includeitemtypes, ['Audio']);
  assert.equal(dispatch('moviesRecursive').plan.menuType, 'movies');
  assert.equal(dispatch('moviesRecursive', {}, null).plan.memoryView, true);
});

test('UserView Ids bypass every builder, including user requirement and menus', () => {
  const result = dispatch('books', { Ids: get('movieB1').Id, IncludeItemTypes: 'Movie', Recursive: false }, null);
  assert.deepEqual(result.query.includeitemtypes, ['Movie']);
  assert.equal(result.plan.repository, true);
  assert.equal(result.plan.viewParent, false);
  assert.throws(() => dispatch('books', {}, null), error => error.status === 500);
  assert.throws(() => dispatch('folders', {}, null), error => error.status === 400);
});

test('UserView default grouped children use only configured eligible movie/TV/mixed folders', () => {
  assert.deepEqual(groupedMediaFolders(folders, user).map(item => item.Id),
    ['libraryA', 'libraryB', 'libraryT', 'libraryM'].map(key => get(key).Id));
  assert.deepEqual(groupedMediaFolders(folders, { Configuration: { GroupedFolders: [get('libraryK').Id] } }), []);
  assert.equal(dispatch('folders').plan.foldersView, true);
  assert.equal(dispatch('default_music').plan.memoryView, true);
  assert.equal(dispatch('numericDefault').plan.memoryView, true);
  assert.equal(dispatch('numericLatest').plan.pageResult, true);
});

test('Items controller parent access check precedes menu dispatch', () => {
  const denied = Object.assign(new Error('denied'), { status: 401 });
  assert.throws(() => itemsDispatch(parseQuery({}), get('moviesRecursive'), state, user, item => {
    assert.equal(item, get('moviesRecursive'));
    throw denied;
  }), error => error === denied);
});

test('Episode and Season native sort names preserve their numbered raw title form', () => {
  assert.equal(sortName({ Type: 'Episode', Name: 'Épisode 中!', ParentIndexNumber: 1, IndexNumber: 2 }), '001 - 0002 - Épisode 中!');
  assert.equal(sortName({ Type: 'Episode', Name: 'Raw ', ParentIndexNumber: -1, IndexNumber: -2 }), '-001 - -0002 - Raw ');
  assert.equal(sortName({ Type: 'Season', Name: 'Season', IndexNumber: 12 }), '0012');
  assert.equal(sortName({ Type: 'Season', Name: 'Raw Season ' }), 'Raw Season ');
  assert.equal(sortName({ Type: 'Episode', Name: 'Ignored', ForcedSortName: 'The A-2' }), 'a0000000002');
});

test('AudioBook inherits raw Audio sorting, including disc/track and forced overrides', () => {
  assert.equal(sortName({ Type: 'AudioBook', Name: 'The 中!', ParentIndexNumber: 2, IndexNumber: 3 }), '0002 - 0003 - The 中!');
  assert.equal(sortName({ Type: 'AudioBook', Name: 'Raw', ForcedSortName: 'The 2' }), '0000000002');
});
