import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { boxSetDisplayOrder, isLegacyBoxSet } from '../../src/library/boxset-state.js';
import { idKey, loadLibrary } from '../../src/library/records.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { visibleItem } from '../../src/library/permissions.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-boxset/input.json', import.meta.url), 'utf8'));
const programDataPath = 'C:\\State';
const byKey = new Map(fixture.items.map(item => [item.key, item]));
const paths = {
  userRoot: 'C:\\State\\root\\default', physicalA: 'C:\\Media\\A', physicalB: 'C:\\Media\\B',
  collections: 'C:\\State\\data\\collections', libraryA: 'C:\\State\\root\\default\\A',
  libraryB: 'C:\\State\\root\\default\\B', collectionLibrary: 'C:\\State\\root\\default\\Collections',
};
const dataRoot = 'C:\\State\\data';
const nativeType = type => ['Movie', 'BoxSet'].includes(type) ? `MediaBrowser.Controller.Entities.Movies.${type}`
  : `MediaBrowser.Controller.Entities.${type}`;
const itemPath = item => {
  if (paths[item.pathKind]) return paths[item.pathKind];
  if (item.pathKind === 'noPath') return null;
  if (item.pathKind === 'dataExact') return dataRoot;
  if (item.pathKind === 'dataTrailing') return dataRoot + '\\';
  if (item.pathKind === 'dataEscape') return dataRoot + '\\..\\outside';
  if (item.pathKind === 'dataUpper') return dataRoot.toUpperCase() + '\\inside';
  if (item.pathKind === 'dataSibling') return dataRoot + '-sibling\\outside';
  if (item.pathKind === 'boxset') return paths.collections + '\\' + item.key;
  return paths.physicalA + '\\' + item.key;
};
async function stateFor(t) {
  const rows = {
    BaseItems: fixture.items.map(item => ({
      Id: item.id, Type: nativeType(item.type), Name: item.name, SortName: item.sortName,
      ParentId: item.parentId, TopParentId: item.topParentId, Path: itemPath(item),
      IsFolder: item.type !== 'Movie', OfficialRating: item.officialRating ?? null,
      InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
      UnratedType: item.type === 'Movie' ? 'Movie' : 'Other', Tags: item.tagsText ?? null,
      // The HTTP/native fixture preparation resolves its location placeholders.
      // Membership itself consumes exact paths, never the cached physical IDs.
      Data: JSON.stringify(item.type === 'CollectionFolder' ? { ...item.data,
        PhysicalLocationsList: (item.data?.PhysicalFolderIds ?? []).map(id => itemPath(fixture.items.find(child => child.id === id))),
      } : item.data ?? {}),
    })),
    AncestorIds: fixture.items.flatMap(item => (item.ancestorIds ?? []).map(id => ({ ItemId: item.id, ParentItemId: id }))),
    LinkedChildren: fixture.links.map(link => ({ ParentId: link.parentId, ChildId: link.childId, ChildType: link.childType, SortOrder: link.sortOrder })),
  };
  const database = await createPostgresTestDatabase(t, 'boxset_children');
  for (const [table, records] of Object.entries(rows)) {
    await database.insertBatch(table, records.map(row => postgresTestRow(table, row)));
  }
  const state = await loadLibrary(database, { programDataPath }, {
    baseRows: await database.rows('BaseItems'), includeManualLinks: true,
  });
  state.valuesFor = () => [];
  return state;
}
const itemFor = (state, key) => state.byId.get(idKey(byKey.get(key).id));
const userFor = policy => ({ Policy: { ...fixture.cases[0].policy, ...policy } });
const options = { programDataPath, configuration: { MetadataCountryCode: 'US' } };

test('legacy classification keeps strict DataPath prefix, equality, separators and raw dot segments', () => {
  const item = Path => ({ Type: 'BoxSet', Path });
  assert.equal(isLegacyBoxSet(item(null), false, programDataPath), false);
  assert.equal(isLegacyBoxSet(item(''), false, programDataPath), false);
  assert.equal(isLegacyBoxSet(item('C:\\Media\\Set'), true, programDataPath), false);
  assert.equal(isLegacyBoxSet(item(dataRoot), false, programDataPath), true);
  for (const value of [dataRoot + '\\', dataRoot + '\\..\\outside', dataRoot.toUpperCase() + '/set']) {
    assert.equal(isLegacyBoxSet(item(value), false, programDataPath), false, value);
  }
  assert.equal(isLegacyBoxSet(item(dataRoot + '-sibling\\set'), false, programDataPath), true);
  assert.equal(isLegacyBoxSet(item('/state/data/set'), false, '/state'), false);
  assert.equal(isLegacyBoxSet(item('/STATE/data/set'), false, '/state'), true);
});

test('legacy Children loads physical rows in stored order; modern Children never exposes physical or linked rows', async t => {
  const state = await stateFor(t);
  assert.deepEqual(state.children(itemFor(state, 'legacyDefault')).map(item => item.Name),
    ['Alpha legacyDefault', 'Beta legacyDefault', 'Nested folder', 'Zulu legacyDefault']);
  assert.equal(state.children(itemFor(state, 'dataExact')).length, 3);
  for (const key of ['dataTrailing', 'dataEscape', 'dataUpper', 'modernEmpty', 'modernNoPath', 'modernExternalLinked']) {
    assert.deepEqual(state.children(itemFor(state, key)), [], key);
  }
});

test('BoxSet DisplayOrder uses case-sensitive CLR enum parsing, numeric values and invalid-name fallback', () => {
  for (const [value, expected] of [
    [undefined, 'PremiereDate'], ['Default', 'Default'], ['SortName', 'SortName'],
    ['sortname', 'PremiereDate'], ['  SortName  ', 'SortName'], ['+10', 'SortName'],
    ['8', 'PremiereDate'], ['Default, SortName', 'SortName'],
    ['2147483647', 'Default'], ['2147483648', 'PremiereDate'], ['', 'PremiereDate'],
  ]) assert.equal(boxSetDisplayOrder({ DisplayOrder: value }), expected);
});

test('IsVisible and an explicitly scoped repository do not reuse standalone library-membership restrictions', async t => {
  const state = await stateFor(t);
  const user = userFor({ EnableAllFolders: false, EnabledFolders: [byKey.get('libraryB').id] });
  const parent = itemFor(state, 'legacyDefault');
  const child = itemFor(state, 'legacyDefaultEarly');
  assert.equal(visibleItem(parent, user, state, { ...options, query: false, checkStandaloneParents: false }), true);
  assert.equal(visibleItem(child, user, state, { ...options, query: false, checkStandaloneParents: false }), true);
  assert.equal(visibleItem(parent, user, state, { ...options, query: false }), false);
  assert.equal(visibleItem(child, user, state, { ...options, query: false }), false);
  assert.equal(visibleItem(child, user, state, { ...options, scopeLibraryFolders: false }), true);
  assert.equal(visibleItem(child, user, state, options), false);
  assert.equal(visibleItem(itemFor(state, 'libraryA'), user, state,
    { ...options, query: false, checkStandaloneParents: false }), false);
});

test('legacy standalone children retain parent rating and tags while their own IsVisible stays separate', async t => {
  const state = await stateFor(t);
  const limited = userFor({ MaxParentalRating: 10 });
  const child = itemFor(state, 'legacyRatedEarly');
  assert.equal(visibleItem(child, limited, state, { ...options, query: false, checkStandaloneParents: false }), true);
  assert.equal(visibleItem(child, limited, state, { ...options, query: false }), false);
  assert.equal(visibleItem(itemFor(state, 'legacyTaggedEarly'), userFor({ BlockedTags: ['block'] }), state,
    { ...options, query: false, checkStandaloneParents: false }), false);
});
