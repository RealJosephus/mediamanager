import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_ID, idKey } from '../../src/library/records.js';
import { parseQuery } from '../../src/library/query.js';
import { filterUserViewItems, userViewPlayedCounts } from '../../src/library/user-view-filter.js';

const id = number => `97000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const item = (number, values = {}) => ({ Id: id(number), Name: 'View ' + number, SortName: String(number),
  Type: 'UserView', IsFolder: true, IsVirtualItem: false, ProviderIds: {}, Genres: [], Studios: [], Tags: [], ...values });
const rows = [item(1), item(2), item(3)];
const stateFor = items => ({ items, byId: new Map(items.map(value => [idKey(value.Id), value])), parents: [], links: [],
  userData: new Map(), rowsFor: () => [], leafIsPlayed: () => false, ancestors: () => [], valuesFor: () => [] });
const filtered = (query, state = stateFor(rows), user = { Id: id(999) }) =>
  filterUserViewItems(rows, parseQuery(query), state, user, { sortNameFor: value => value.SortName }).map(value => value.Id);

test('UserView image filters match bound enum names and unknown numeric values against direct image rows', () => {
  const state = stateFor(rows);
  state.imageInfos = [{ ItemId: rows[0].Id, ImageType: 0 }, { ItemId: rows[1].Id, ImageType: 2 }, { ItemId: rows[2].Id, ImageType: 99 }];
  assert.deepEqual(filtered({ ImageTypes: 'primary' }, state), [rows[0].Id]);
  assert.deepEqual(filtered({ ImageTypes: '0,Backdrop' }, state), [rows[0].Id, rows[1].Id]);
  assert.deepEqual(filtered({ ImageTypes: '99' }, state), [rows[2].Id]);
  assert.deepEqual(filtered({ ImageTypes: 'Art' }, state), []);
  state.parents = [{ ItemId: id(9), ParentItemId: rows[0].Id }];
  state.imageInfos = [{ ItemId: id(9), ImageType: 0 }];
  assert.deepEqual(filtered({ ImageTypes: 'Primary' }, state), [], 'a descendant image is not a view image');
});

test('UserView menus ignore unbound IsFolder and repository-only predicates but keep Filters=IsFolder', () => {
  for (const IsFolder of ['true', 'false', 'invalid']) assert.deepEqual(parseQuery({ IsFolder }), {});
  assert.deepEqual(parseQuery({ Filters: 'IsFolder' }), { filters: ['IsFolder'], isfolder: true });
  assert.deepEqual(filtered({ SearchTerm: 'missing', AlbumIds: id(99) }), rows.map(value => value.Id));
  assert.deepEqual(filtered({ Filters: 'IsFolder' }), rows.map(value => value.Id));
  assert.deepEqual(filtered({ IncludeItemTypes: 'Movie' }), []);
});

test('UserView favorite/like/resume predicates use preferred data and require a user only when evaluated', () => {
  const state = stateFor(rows);
  state.userData.set(idKey(rows[0].Id), { IsFavorite: true, Likes: null, PlaybackPositionTicks: 0n });
  state.userData.set(idKey(rows[1].Id), { IsFavorite: false, Likes: true, PlaybackPositionTicks: 10n });
  assert.deepEqual(filtered({ Filters: 'IsFavoriteOrLikes' }, state), [rows[0].Id, rows[1].Id]);
  assert.deepEqual(filtered({ Filters: 'IsResumable' }, state), [rows[1].Id]);
  assert.deepEqual(filtered({ IsFavorite: false }, state), [rows[1].Id, rows[2].Id]);
  assert.throws(() => filtered({ IsFavorite: true }, state, null), error => error.status === 500);
  assert.deepEqual(filtered({ IncludeItemTypes: 'Movie', IsFavorite: true }, state, null), [], 'type rejection precedes user data access');
  assert.deepEqual(filtered({ Filters: 'IsPlayed' }, state, null), rows.map(value => value.Id), 'no-user played filter is ignored');
});

test('UserView genre/studio selector resolution is lazy and Guid.Empty errors only on evaluation', () => {
  assert.throws(() => filtered({ GenreIds: EMPTY_ID }), error => error.status === 400);
  assert.deepEqual(filtered({ IncludeItemTypes: 'Movie', GenreIds: EMPTY_ID }), []);
  const state = stateFor([...rows, item(10, { Name: 'Drama' })]);
  const view = { ...rows[0], Genres: ['DRAMA'], Studios: ['Drama'] };
  assert.equal(filterUserViewItems([view], parseQuery({ GenreIds: id(10), StudioIds: id(10) }), state, null,
    { sortNameFor: value => value.SortName }).length, 1);
});

test('UserView folder played counts merge presentation peers and count distinct stored/link leaves', () => {
  const peer = item(4, { PresentationUniqueKey: 'same-view' });
  const folder = { ...rows[0], PresentationUniqueKey: 'same-view' };
  const leaf = item(5, { Type: 'Movie', IsFolder: false });
  const virtual = item(6, { Type: 'Movie', IsFolder: false, IsVirtualItem: true });
  const nested = item(7, { Type: 'Folder' });
  const linked = item(8, { Type: 'Movie', IsFolder: false });
  const alternate = item(9, { Type: 'Movie', IsFolder: false });
  const state = stateFor([folder, peer, leaf, virtual, nested, linked, alternate]);
  state.parents = [{ ItemId: leaf.Id, ParentItemId: folder.Id }, { ItemId: virtual.Id, ParentItemId: folder.Id },
    { ItemId: linked.Id, ParentItemId: nested.Id }];
  state.links = [{ ParentId: folder.Id, ChildId: leaf.Id, ChildType: 0 },
    { ParentId: peer.Id, ChildId: nested.Id, ChildType: 0 }, { ParentId: leaf.Id, ChildId: alternate.Id, ChildType: 2 }];
  state.rowsFor = value => [leaf.Id, alternate.Id].includes(value.Id) ? [{ Played: true }] : [];
  const counts = userViewPlayedCounts([folder, rows[2]], state, null, {});
  assert.deepEqual(counts.get(idKey(folder.Id)), { Total: 2, Played: 1 });
  assert.deepEqual(counts.get(idKey(rows[2].Id)), { Total: 0, Played: 0 }, 'an empty folder is played under Played >= Total');
});
