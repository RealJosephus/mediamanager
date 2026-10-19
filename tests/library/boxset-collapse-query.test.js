import assert from 'node:assert/strict';
import test from 'node:test';
import { BindingError } from '../../src/http/binding.js';
import { sortName } from '../../src/library/dto.js';
import { hasFilters, parseQuery } from '../../src/library/query.js';
import { idKey, sameId } from '../../src/library/records.js';
import { boxSetCollapsePlan, collapseRepositoryBoxSets, collapseMemoryBoxSets, filterCollapsedNames,
  boxSetLinkedChildren, boxSetRepositoryDescendants } from '../../src/library/boxset-collapse.js';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';

const id = number => `79000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const user = { Id: id(90), Policy: { EnableAllFolders: true, BlockUnratedItems: [] } };
const movies = { EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: false };
const series = { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: true };
const both = { EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: true };
const parent = { Type: 'Folder' };
const plan = (query, configuration = movies, repository = true, queryUser = user, queryParent = parent) =>
  boxSetCollapsePlan(query, { configuration, repository, user: queryUser, parent: queryParent });

function scenario() {
  const items = [
    [1, 'AggregateFolder', 'Aggregate', null, 'C:\\server\\root'],
    [2, 'Folder', 'Collections', 1, 'C:\\server\\data\\collections'],
    [3, 'Folder', 'Library', 1, 'C:\\media'],
    [4, 'Movie', '21 Jump Street', 3],
    [5, 'Series', 'Alpha Series', 3],
    [6, 'Audio', 'Beta Audio', 3],
    [7, 'BoxSet', 'Empty Box', 3],
    [8, 'BoxSet', 'Jump Street Collection', 2],
    [9, 'BoxSet', 'Shared Collection', 2],
    [10, 'BoxSet', 'Series Collection', 2],
    [11, 'BoxSet', 'Audio Collection', 2],
    [12, 'Movie', 'Nonmanual Movie', 3],
    [13, 'BoxSet', 'Nonmanual Collection', 2],
    [14, 'BoxSet', 'Nested Collection', 2],
    [15, 'Movie', 'First Version', 3],
    [16, 'Movie', 'Second Version', 3],
    [17, 'BoxSet', 'Version Collection', 2],
  ].map(([number, Type, Name, parentNumber, Path]) => ({
    Id: id(number), Type, Name, SortName: Name.toLowerCase(),
    PresentationUniqueKey: number === 15 || number === 16 ? 'same-key' : `key-${number}`,
    ParentId: parentNumber == null ? null : id(parentNumber), Path: Path ?? `C:\\media\\${number}`,
    IsFolder: ['Folder', 'AggregateFolder', 'BoxSet', 'Series'].includes(Type),
    Tags: [], UnratedType: 'Other',
  }));
  const links = [[8, 4, 0], [9, 4, 0], [10, 5, 0], [11, 6, 0], [13, 12, 2], [14, 8, 0], [17, 16, 0]]
    .map(([Parent, Child, ChildType], SortOrder) => ({ ParentId: id(Parent), ChildId: id(Child), ChildType, SortOrder }));
  const byId = new Map(items.map(item => [idKey(item.Id), item]));
  const linkedChildrenByParent = new Map();
  for (const link of links) {
    const key = idKey(link.ParentId);
    if (!linkedChildrenByParent.has(key)) linkedChildrenByParent.set(key, []);
    linkedChildrenByParent.get(key).push(byId.get(idKey(link.ChildId)));
  }
  const state = { items, byId, links, parents: [], linkedChildrenByParent, ancestors: () => [],
    children: folder => items.filter(item => sameId(item.ParentId, folder.Id)) };
  const get = number => byId.get(idKey(id(number)));
  return { state, get, members: [4, 5, 6, 7, 12, 15, 16].map(get), options: { programDataPath: 'C:\\server' } };
}
const ids = items => items.map(item => item.Id);

test('boxset collapse binds the first nullable boolean and remains a dispatch option', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('CollapseBoxSetItems=true')), { collapseboxsetitems: true });
  assert.deepEqual(parseQuery(new URLSearchParams('CollapseBoxSetItems=')), {});
  assert.deepEqual(parseQuery(new URLSearchParams('CollapseBoxSetItems=false&CollapseBoxSetItems=true')),
    { collapseboxsetitems: false });
  assert.throws(() => parseQuery({ CollapseBoxSetItems: 'invalid' }), error =>
    error instanceof BindingError && error.status === 400
    && error.errors.collapseBoxSetItems[0] === "The value 'invalid' is not valid.");
  assert.equal(hasFilters({ collapseboxsetitems: true }), false);
});

test('boxset plans preserve repository and memory configuration differences', () => {
  assert.deepEqual(plan({}), { active: true, types: ['Movie'] });
  assert.deepEqual(plan({}, series), { active: true, types: ['Series'] });
  assert.deepEqual(plan({}, both), { active: true, types: [] });
  assert.deepEqual(plan({}, {}), { active: false, types: [] });
  assert.deepEqual(plan({ includeitemtypes: ['Audio'], collapseboxsetitems: true }, {}), { active: true, types: [] });
  assert.deepEqual(plan({ includeitemtypes: ['Series'] }), { active: false, types: [] });
  assert.deepEqual(plan({ collapseboxsetitems: false }, both), { active: false, types: [] });
  assert.deepEqual(plan({ collapseboxsetitems: true }, {}, false), { active: false, types: [] });
  assert.deepEqual(plan({}, both, false), { active: true, types: ['Movie', 'Series'] });
  assert.deepEqual(plan({}, {}, true, null), { active: true, types: [] });
  assert.deepEqual(plan({ collapseboxsetitems: true }, both, false, null), { active: false, types: ['Movie', 'Series'] });
});

test('automatic collapse exclusions do not clear an incoming true repository flag', () => {
  const nullable = ['isfavorite', 'favoriteorlikes', 'likes', 'isplayed', 'isresumable', 'isfolder',
    'hasimdbid', 'hasofficialrating', 'hasoverview', 'hasparentalrating', 'hasspecialfeature', 'hassubtitles',
    'hasthemesong', 'hasthemevideo', 'hastmdbid', 'hastrailer', 'is3d', 'is4k', 'ishd', 'islocked', 'isplaceholder', 'minindexnumber'];
  const collections = ['genres', 'genreids', 'imagetypes', 'personids', 'studioids', 'videotypes', 'years', 'tags', 'officialratings'];
  for (const query of [...nullable.map(key => ({ [key]: false })), ...collections.map(key => ({ [key]: ['value'] })),
    { person: 'An Actor' }, ...['CommunityRating', 'CriticRating', 'Runtime'].map(value => ({ sortby: [value] }))]) {
    assert.equal(plan(query).active, false);
    assert.deepEqual(plan({ ...query, collapseboxsetitems: true }), { active: true, types: [] });
    assert.equal(plan({ ...query, collapseboxsetitems: true }, movies, false).active, false);
  }
  for (const Type of ['BoxSet', 'Season', 'MusicAlbum', 'MusicArtist']) {
    assert.equal(plan({}, movies, true, user, { Type }).active, false);
    assert.deepEqual(plan({ collapseboxsetitems: true }, movies, true, user, { Type }), { active: true, types: [] });
  }
  for (const query of [{ ids: [id(4)] }, { searchterm: 'Solo' }]) {
    assert.deepEqual(plan({ ...query, collapseboxsetitems: true }), { active: false, types: [] });
  }
  assert.equal(plan({ issports: false, hastvdbid: false, person: ' \t', years: [] }).active, true);
});

test('repository collapse is a single manual-link projection with distinct parents', () => {
  const { state, get, members } = scenario();
  assert.deepEqual(ids(collapseRepositoryBoxSets(members, state)), [8, 9, 10, 11, 12, 15, 17].map(id));
  assert.deepEqual(ids(collapseRepositoryBoxSets(members, state, ['Movie'])), [8, 9, 5, 6, 7, 12, 15, 17].map(id));
  assert.deepEqual(ids(collapseRepositoryBoxSets([get(8)], state)), [id(14)]);
  assert.deepEqual(ids(collapseRepositoryBoxSets([get(7)], state)), []);
  assert.deepEqual(ids(collapseRepositoryBoxSets([get(7)], state, ['Movie'])), [id(7)]);
  assert.deepEqual(ids(collapseRepositoryBoxSets([get(4), get(4)], state)), [id(8), id(9)]);
});

test('memory collapse uses visible physical collections and accepts every linked-child type', () => {
  const { state, members, get, options } = scenario();
  assert.deepEqual(ids(collapseMemoryBoxSets(members, state, user, options, ['Movie'])), [8, 9, 13, 15, 17, 5, 6, 7].map(id));
  assert.deepEqual(ids(collapseMemoryBoxSets(members, state, user, options, ['Movie', 'Series'])), [8, 9, 10, 6, 7, 13, 15, 17].map(id));
  assert.deepEqual(ids(collapseMemoryBoxSets([get(4)], state, user, { programDataPath: 'C:\\elsewhere' }, ['Movie'])), [id(4)]);
  state.links.push({ ParentId: id(15), ChildId: id(16), ChildType: 2, SortOrder: 7 });
  // Only an already-returned local alternate suppresses the unlinked movie.
  state.links = state.links.filter(link => !sameId(link.ParentId, id(17)));
  assert.deepEqual(ids(collapseMemoryBoxSets([get(16), get(15)], state, user, options, ['Movie'])), [id(16)]);
  assert.deepEqual(ids(collapseMemoryBoxSets([get(15), get(16)], state, user, options, ['Movie'])), [id(15), id(16)]);
});

test('post-collapse names inspect the substituted collection with native casing rules', () => {
  const { get } = scenario();
  assert.deepEqual(ids(filterCollapsedNames([get(4), get(8)], { namestartswith: 'JUMP' })), [id(8)]);
  assert.deepEqual(ids(filterCollapsedNames([get(8)], { namestartswith: '21' })), []);
  assert.deepEqual(ids(filterCollapsedNames([get(4), get(8)], { namestartswithorgreater: 'J', namelessthan: 'K' })), [id(8)]);
  const unicode = [{ Id: id(80), SortName: 'Éclair' }];
  assert.deepEqual(filterCollapsedNames(unicode, { namestartswith: 'é' }), []);
  assert.deepEqual(filterCollapsedNames(unicode, { namestartswith: 'é' }, { memory: true }), unicode);
  assert.deepEqual(filterCollapsedNames(unicode, { namestartswith: ' \t' }), unicode);
});

test('local BoxSet links require user-root library affiliation while remote links use visibility', () => {
  const { state, get, options } = scenario();
  const library = { Id: id(85), Type: 'CollectionFolder', PhysicalLocationsList: ['C:\\MEDIA'], IsFolder: true };
  assert.deepEqual(collectionFoldersForItem(get(4), state, [library]), [library]);
  assert.deepEqual(collectionFoldersForItem(get(4), state, []), []);
  assert.deepEqual(ids(boxSetLinkedChildren(get(8), state, user, [], options)), []);
  assert.deepEqual(ids(boxSetLinkedChildren(get(8), state, user, [library], options)), [id(4)]);
  get(4).Path = 'https://example.invalid/movie';
  assert.deepEqual(ids(boxSetLinkedChildren(get(8), state, user, [], options)), [id(4)]);
  assert.deepEqual(ids(boxSetLinkedChildren(get(8), state, null, [], options)), [id(4)]);
});

test('recursive BoxSet descendants follow folder links and closures without walking movie alternates', () => {
  const { state, get } = scenario();
  state.parents.push({ ItemId: id(15), ParentItemId: id(5) });
  state.links.push({ ParentId: id(8), ChildId: id(5), ChildType: 1, SortOrder: 7 },
    { ParentId: id(8), ChildId: id(14), ChildType: 0, SortOrder: 8 },
    { ParentId: id(4), ChildId: id(16), ChildType: 2, SortOrder: 9 });
  assert.deepEqual(ids(boxSetRepositoryDescendants(get(8), state)), [4, 5, 14, 15].map(id));
});

test('Audio sort names preserve titles and format disc/track numbers unless explicitly forced', () => {
  assert.equal(sortName({ Type: 'Audio', Name: 'The Éclair 21' }), 'The Éclair 21');
  assert.equal(sortName({ Type: 'Audio', Name: 'Beta Audio', ParentIndexNumber: 2, IndexNumber: 12 }), '0002 - 0012 - Beta Audio');
  assert.equal(sortName({ Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: 'Title', IndexNumber: -1 }), '-0001 - Title');
  assert.equal(sortName({ Type: 'Audio', Name: 'Title', IndexNumber: 12345 }), '12345 - Title');
  assert.equal(sortName({ Type: 'Audio', Name: 'Title', ForcedSortName: 'The Éclair 21' }), 'eclair 0000000021');
});
