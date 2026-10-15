import assert from 'node:assert/strict';
import test from 'node:test';
import { childCountSourceIds } from '../../src/library/child-counts.js';
import { EMPTY_ID, idKey } from '../../src/library/records.js';

const id = number => number.toString(16).padStart(32, '0');
const folder = (number, values = {}) => ({ Id: id(number), Type: 'Folder', IsFolder: true, ...values });
const leaf = (number, parent, values = {}) => ({ Id: id(number), ParentId: id(parent), Type: 'Movie', IsFolder: false, ...values });
const user = values => ({ Policy: { EnableAllFolders: true, ...values?.Policy }, ...values });
function stateFor(items, { links = [], parents = [], tags = new Map(), children = [] } = {}) {
  return { items, links, parents, byId: new Map(items.map(item => [idKey(item.Id), item])),
    valuesFor: item => tags.get(idKey(item.Id)) ?? [], ancestors: () => [], children: () => children };
}

test('child sources proxy physical libraries and original-folder views, with single-parent precedence', () => {
  const physical = folder(1);
  const library = folder(2, { Type: 'CollectionFolder', PhysicalFolderIds: [id(1), id(1)] });
  const wrongParent = folder(3);
  const state = stateFor([physical, library, wrongParent]);
  assert.deepEqual(childCountSourceIds(library, state, user()), [id(1), id(1)]);
  assert.deepEqual(childCountSourceIds(physical, state, user()), [id(1)]);
  for (const ViewType of ['books', 'musicvideos', 'homevideos', 'photos', 'music', 'boxsets', 'movies', 'tvshows']) {
    const view = folder(4, { Type: 'UserView', ViewType, ParentId: id(3), DisplayParentId: id(2) });
    assert.deepEqual(childCountSourceIds(view, state, user()), [id(1), id(1)], ViewType);
  }
  const view = folder(4, { Type: 'UserView', ViewType: 'music', ParentId: id(3), DisplayParentId: EMPTY_ID });
  assert.deepEqual(childCountSourceIds(view, state, user()), [id(3)]);
  assert.equal(childCountSourceIds({ ...view, DisplayParentId: id(99) }, state, user()), null);
  assert.equal(childCountSourceIds(leaf(5, 1), state, user()), null);
});

test('grouped movie and TV sources use supplied visible root children and distinct physical IDs', () => {
  const movies = folder(1, { Type: 'CollectionFolder', CollectionType: 'movies', PhysicalFolderIds: [id(11), id(12)] });
  const mixed = folder(2, { Type: 'CollectionFolder', CollectionType: null, PhysicalFolderIds: [id(12), id(13)] });
  const tv = folder(3, { Type: 'CollectionFolder', CollectionType: 'tvshows', PhysicalFolderIds: [id(14)] });
  const hidden = folder(4, { Type: 'CollectionFolder', CollectionType: 'movies', PhysicalFolderIds: [id(15)] });
  const music = folder(5, { Type: 'CollectionFolder', CollectionType: 'music', PhysicalFolderIds: [id(16)] });
  const nestedView = folder(6, { Type: 'UserView' });
  const state = stateFor([movies, mixed, tv, hidden, music, nestedView]);
  const account = user({ Configuration: { GroupedFolders: [id(1), id(2), id(3), id(4), id(5)] } });
  const rootChildren = [movies, mixed, tv, music];
  const movieView = folder(7, { Type: 'UserView', ViewType: 'movies', DisplayParentId: id(6) });
  assert.deepEqual(childCountSourceIds(movieView, state, account, { rootChildren }), [id(11), id(12), id(13)]);
  assert.deepEqual(childCountSourceIds({ ...movieView, ViewType: 'tvshows' }, state, account,
    { rootChildren: () => rootChildren }), [id(12), id(13), id(14)]);
  for (const ViewType of ['playlists', 'folders', 'moviegenres', 'moviegenre', 'moviemovies', 'tvnextup', 'music']) {
    assert.equal(childCountSourceIds({ ...movieView, ViewType }, state, account, { rootChildren }), null, ViewType);
  }
});
