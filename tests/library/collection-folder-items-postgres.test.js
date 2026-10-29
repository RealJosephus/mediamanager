import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const id = value => '83b00000-0000-0000-0000-' + String(value).padStart(12, '0');
const tableNames = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'UserData',
  'MediaStreamInfos', 'Peoples', 'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields'];
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const temporary = async db => (await db.client.query('SELECT oid::text,relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY oid')).rows;
const backend = async db => (await db.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
const snapshot = async db => Object.fromEntries(await Promise.all(tableNames.map(async table => [table, await db.rows(table)])));
const user = { Id: id(99), Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [],
  AllowedTags: [], MaxParentalRating: null, MaxParentalSubRating: null, BlockUnratedItems: [], EnableContentDeletion: false },
Configuration: { GroupedFolders: [], DisplayMissingEpisodes: false } };
const roots = () => [
  { key: 'aggregate', type: 'AggregateFolder', Id: id(1), Path: 'Z:\\ChildSelection', IsRoot: true },
  { key: 'user-root', type: 'UserRootFolder', Id: id(2), Path: 'Z:\\ChildSelection\\root', IsRoot: true },
  { key: 'physical-a', type: 'Folder', Id: id(3), parent: 'aggregate', Path: 'Z:\\ChildSelection\\A', links: ['physical-link'] },
  { key: 'physical-b', type: 'Folder', Id: id(4), parent: 'aggregate', Path: 'Z:\\ChildSelection\\B' },
  { key: 'collection', type: 'CollectionFolder', Id: id(5), parent: 'user-root', Path: 'Z:\\ChildSelection\\root\\Library',
    PhysicalFolderIds: [id(3), id(4)], PhysicalLocationsList: ['Z:\\ChildSelection\\A', 'Z:\\ChildSelection\\B'],
    CollectionType: 'movies', links: ['own-link'] },
  { key: 'unrelated', type: 'Folder', Id: id(6), parent: 'aggregate', Path: 'Z:\\ChildSelection\\other' },
];
const controls = () => [
  { key: 'logical-row', type: 'Movie', Id: id(20), parent: 'collection', ProductionYear: 2200 },
  { key: 'physical-link', type: 'Movie', Id: id(21), parent: 'unrelated', ProductionYear: 2030 },
  { key: 'own-link', type: 'Movie', Id: id(22), parent: 'unrelated', ProductionYear: 2014,
    Name: 'Own linked media', SortName: '999-own', Path: 'Z:\\ChildSelection\\other\\own.mkv' },
];
const input = extra => ({ parentId: id(5), recursive: false, includeItemTypes: ['Movie'], sortBy: ['SortName'],
  fields: ['Path', 'SortName', 'Overview'], enableUserData: false, ...extra });

// Keep actual admitted SQL work ahead of the fixture's close/drop after-hook
// when node:test signals a timeout. Cancellation does not grant a second owner.
function owned(t, operation) {
  let body;
  t.after(async () => { if (body) await outcome(body); });
  body = (async () => {
    const f = await setupChildrenFixture(t); t.signal.throwIfAborted();
    f.configuration.EnableGroupingMoviesIntoCollections = false;
    f.configuration.EnableGroupingShowsIntoCollections = false;
    return operation(f);
  })();
  return body;
}

test('CollectionFolder Items uses physical Children and its own links, preserves live values and recovers from real SQL failures', {
  skip: !enabled, timeout: 90000,
}, t => owned(t, async f => {
  await f.seed({ target: 'collection', items: [...roots(),
    { key: 'first', type: 'Movie', Id: id(10), parent: 'physical-a', ProductionYear: 1900, Name: 'First physical media', SortName: '010-first' },
    { key: 'second', type: 'Movie', Id: id(11), parent: 'physical-b', ProductionYear: 1901, Name: 'Second physical media', SortName: '011-second' },
    ...controls(),
  ] });
  const output = path.join(validationOutputRoot(), 'collection-folder-items-' + randomUUID()); await mkdir(output);
  const report = { phaseAcceptance: false, releaseAcceptance: false, nativeExecutedByThisTest: false,
    boundary: 'Real PostgreSQL and formal queryItems over two physical Folder.Children owners plus the logical CollectionFolder own linked batch. Complete public values/windows and domain state, real TEMP disappearance and same-backend recovery. Full designated Native HTTP is exercised by year-list-http over the 2200/2030/1900 controls.', observations: [] };
  try {
    await f.store.run(async db => {
      const before = await snapshot(db), physical = await backend(db), tables = await temporary(db);
      const all = await f.library.queryItems(input(), { user }); report.observations.push(all);
      assert.deepEqual(all.Items.map(item => item.Id), [10, 22, 11].map(value => idKey(id(value))));
      assert.deepEqual(all.Items.map(item => item.Name), ['First physical media', 'Own linked media', 'Second physical media']);
      assert.equal(all.TotalRecordCount, 3); assert.equal(all.StartIndex, 0);
      for (const year of [2200, 2030]) assert.deepEqual(await f.library.queryItems(input({ years: [year] }), { user }),
        { Items: [], TotalRecordCount: 0, StartIndex: 0 });
      const api = await f.library.queryItems(input(), {});
      assert.deepEqual(api.Items.map(item => item.Id), [10, 11].map(value => idKey(id(value)))); assert.equal(api.TotalRecordCount, 2);
      assert.deepEqual(await f.library.queryItems(input({ limit: 0 }), { user }), all);
      const selected = await f.library.queryItems(input({ startIndex: 1, limit: 1 }), { user });
      assert.equal(selected.TotalRecordCount, 3); assert.equal(selected.StartIndex, 1); assert.deepEqual(selected.Items, all.Items.slice(1, 2));

      // Metadata can replace real physical Children with unsaved values. Both
      // physical sources must remain alive through linked resolution and DTOs.
      for (const [parent, itemId, name, year] of [[3, 10, 'Live physical A', 1990], [4, 11, 'Live physical B', 1991]]) {
        await f.library.itemCreation.withItem(id(parent), folder => {
          const child = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
          Object.assign(child, { Id: id(itemId), ParentId: folder.Id, Name: name, ForcedSortName: '0' + itemId,
            ProductionYear: year, Overview: name + ' overview', Path: 'Z:\\ChildSelection\\warm-' + parent + '.mkv' });
          setFolderChildren(folder, [child]);
        });
      }
      const warm = await f.library.queryItems(input({ years: [1990, 1991] }), { user }); report.observations.push(warm);
      assert.deepEqual(warm.Items.map(item => [item.Name, item.ProductionYear, item.Overview, item.Path]), [
        ['Live physical A', 1990, 'Live physical A overview', 'Z:\\ChildSelection\\warm-3.mkv'],
        ['Live physical B', 1991, 'Live physical B overview', 'Z:\\ChildSelection\\warm-4.mkv'],
      ]);
      assert.equal(warm.TotalRecordCount, 2);
      for (const marker of [false, 0, '', null, undefined]) {
        t.signal.throwIfAborted();
        const query = db.client.query; let armed = true;
        db.client.query = async (...args) => {
          const result = await query.apply(db.client, args), text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          if (armed && typeof text === 'string' && /^INSERT INTO "mm_native_query_/u.test(text)) { armed = false; throw marker; }
          return result;
        };
        let failed;
        try { failed = await outcome(f.library.queryItems(input(), { user })); }
        finally { db.client.query = query; }
        assert.equal(failed.failed, true); assert.equal(failed.reason, marker);
        assert.deepEqual(await temporary(db), tables); assert.deepEqual(await backend(db), physical);
        const recovered = await f.library.queryItems(input({ years: [1990, 1991] }), { user });
        assert.deepEqual(recovered, warm);
      }
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await temporary(db), tables); assert.deepEqual(await backend(db), physical);
      report.before = before; report.after = await snapshot(db); report.backend = physical;
    });
  } finally { await writeFile(path.join(output, 'report.json'), json(report)); }
}));

test('CollectionFolder combined source retains its full zero-limit result before the final cross-folder DTO page', {
  skip: !enabled, timeout: 90000,
}, t => owned(t, async f => {
  await f.seed({ target: 'collection', items: [...roots(), ...Array.from({ length: 130 }, (_, index) => ({
    key: 'movie-' + index, type: 'Movie', Id: id(100 + index), parent: index < 65 ? 'physical-a' : 'physical-b',
    Name: 'Movie ' + String(index).padStart(3, '0'), SortName: String(index).padStart(3, '0'), ProductionYear: 1900 + index,
  })), ...controls()] });
  const output = path.join(validationOutputRoot(), 'collection-folder-pages-' + randomUUID()); await mkdir(output);
  const report = { phaseAcceptance: false, releaseAcceptance: false, nativeExecutedByThisTest: false, pages: [] };
  try {
    await f.store.run(async db => {
      const before = await snapshot(db), physical = await backend(db), tables = await temporary(db), query = db.client.query;
      db.client.query = async (...args) => {
        const result = await query.apply(db.client, args), text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (typeof text === 'string' && (/^FETCH FORWARD 128 FROM "mm_cached_folder_/u.test(text)
          || /^\s*SELECT\b/u.test(text) && /\bLIMIT 128\b/u.test(text) && /"mm_(?:folder_|native_query_)/u.test(text))) {
          assert.ok(result.rows.length <= 128, 'A real candidate page exceeded the retained item bound.');
          report.pages.push({ returned: result.rows.length });
        }
        return result;
      };
      try {
        const zero = await f.library.queryItems(input({ limit: 0 }), { user });
        assert.equal(zero.TotalRecordCount, 131); assert.equal(zero.StartIndex, 0);
        assert.deepEqual(zero.Items.map(item => item.Id), [...Array.from({ length: 130 }, (_, index) => idKey(id(100 + index))), idKey(id(22))]);
        t.signal.throwIfAborted();
        const page = await f.library.queryItems(input({ startIndex: 63, limit: 5 }), { user });
        assert.equal(page.TotalRecordCount, 131); assert.equal(page.StartIndex, 63);
        assert.deepEqual(page.Items.map(item => item.Name), [63, 64, 65, 66, 67].map(value => 'Movie ' + String(value).padStart(3, '0')));
        assert.deepEqual(page.Items.map(item => item.Id), [163, 164, 165, 166, 167].map(value => idKey(id(value))));
        assert.deepEqual(page.Items, zero.Items.slice(63, 68));
        report.fullZeroLimitResponse = zero; report.response = page;
      } finally { db.client.query = query; }
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await temporary(db), tables); assert.deepEqual(await backend(db), physical);
      report.backend = physical;
    });
  } finally { await writeFile(path.join(output, 'report.json'), json(report)); }
}));
