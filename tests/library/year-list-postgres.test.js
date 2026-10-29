import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { nativeYearIdentity } from '../../src/library/year-identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { observeExecutionPhase } from '../../tools/validation/execution-diagnostics.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const id = number => '83900000-0000-0000-0000-' + String(number).padStart(12, '0');
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const temporary = async db => (await db.client.query('SELECT oid::text,relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY oid')).rows;
const backend = async db => (await db.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
const yearRows = f => f.database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Year' } });
const user = { Id: id(99), Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [],
  AllowedTags: [], MaxParentalRating: null, MaxParentalSubRating: null, BlockUnratedItems: [], EnableContentDeletion: false },
Configuration: { GroupedFolders: [], DisplayMissingEpisodes: false } };
const roots = () => [{ key: 'user-root', type: 'UserRootFolder', Id: id(1), IsRoot: true, PhysicalLocationsList: [] },
  { key: 'root', type: 'Folder', Id: id(2), parent: 'user-root', Path: 'Z:\\ChildSelection\\root' }];

// Retain the actual admitted body through node:test cancellation. The existing
// fixture's resource after-hook runs only after this earlier ownership fence.
function owned(t, operation) {
  let body;
  t.after(async () => { if (body) await outcome(body); });
  body = (async () => {
    const f = await setupChildrenFixture(t); t.signal.throwIfAborted(); return operation(f);
  })();
  return body;
}

test('Years uses Folder occurrence counts and Guid winners while excluded folders still contribute matching descendants', {
  skip: !enabled, timeout: 60000,
}, t => owned(t, async f => {
  const source = roots(); source[1].links = ['nested-movie'];
  await f.seed({ target: 'root', items: [...source,
    { key: 'nested', type: 'Folder', Id: id(3), parent: 'root', ProductionYear: 1980 },
    { key: 'root-movie', type: 'Movie', Id: id(4), parent: 'root', ProductionYear: 2000, MediaType: 'Video' },
    { key: 'nested-movie', type: 'Movie', Id: id(5), parent: 'nested', ProductionYear: 2001, MediaType: 'Video' },
    { key: 'no-year', type: 'Movie', Id: id(6), parent: 'root', ProductionYear: null, MediaType: 'Video' },
    { key: 'zero-year', type: 'Movie', Id: id(7), parent: 'root', ProductionYear: 0, MediaType: 'Video' },
  ] });
  t.signal.throwIfAborted();
  const input = { parentId: id(2), includeItemTypes: ['Movie'], excludeItemTypes: ['Folder'], sortBy: ['Name'] };
  const selected = await f.library.queryYears(input, { user, hasUser: true, signal: t.signal });
  assert.deepEqual(selected.Items.map(item => item.Name), ['2000', '2001']); assert.equal(selected.TotalRecordCount, 5);
  assert.equal(new Set(selected.Items.map(item => item.Id)).size, selected.Items.length);
  const api = await f.library.queryYears(input, { signal: t.signal });
  assert.equal(api.TotalRecordCount, 2); assert.deepEqual(api.Items.map(item => item.Name), ['2000', '2001']);
  const direct = await f.library.queryYears({ ...input, recursive: false }, { user, hasUser: true, signal: t.signal });
  assert.equal(direct.TotalRecordCount, 2); assert.deepEqual(direct.Items.map(item => item.Name), ['2000', '2001']);
  const leaf = await f.library.queryYears({ parentId: id(4) }, { signal: t.signal });
  assert.equal(leaf.TotalRecordCount, 1); assert.deepEqual(leaf.Items.map(item => item.Name), ['2000']);
  const filteredLeaf = await f.library.queryYears({ parentId: id(4), mediaTypes: ['Audio'] }, { signal: t.signal });
  assert.deepEqual(filteredLeaf, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  const missing = await outcome(f.library.queryYears({ parentId: id(999) }, { signal: t.signal }));
  assert.equal(missing.failed, true); assert.equal(missing.reason.status, 400);
  assert.deepEqual((await yearRows(f)).map(row => row.Name).sort(), ['2000', '2001']);
}));

test('Years borrows the admitted Aggregate root with warm Children while its virtual Folder owns a real SQL link relation', {
  skip: !enabled, timeout: 60000,
}, t => owned(t, async f => {
  await f.seed({ target: 'aggregate', items: [
    { key: 'aggregate', type: 'AggregateFolder', Id: id(800), IsRoot: true, PhysicalLocationsList: [] },
    { key: 'user-root', type: 'UserRootFolder', Id: id(801), parent: 'aggregate', IsRoot: true },
    { key: 'movie', type: 'Movie', Id: id(802), parent: 'aggregate', ProductionYear: 2000, MediaType: 'Video' },
    { key: 'virtual', type: 'Folder', Id: id(803), links: ['movie'] },
  ] });
  t.signal.throwIfAborted();
  await f.library.itemCreation.withItem(id(800), aggregate =>
    f.library.itemCreation.withItem(id(803), virtual =>
      f.library.itemCreation.withItem(id(802), async movie => {
        aggregate.VirtualChildren.push(virtual);
        movie.ProductionYear = 2001;
        setFolderChildren(aggregate, [movie]);
        const linked = () => f.linkedChildren.page(virtual.LinkedChildren);
        const beforeLinks = await linked(); assert.equal(beforeLinks.length, 1);
        assert.equal(f.idKey(beforeLinks[0].ItemId), f.idKey(movie.Id));
        await f.store.run(async db => {
          const before = await temporary(db), originalBackend = await backend(db);
          const selected = await f.library.queryYears({ parentId: aggregate.Id, recursive: false,
            includeItemTypes: ['Movie'], sortBy: ['Name'] }, { signal: t.signal });
          assert.deepEqual(selected.Items.map(item => item.Name), ['2001']);
          assert.equal(selected.TotalRecordCount, 1); assert.equal(selected.StartIndex, 0);
          assert.deepEqual((await yearRows(f)).map(row => row.Name), ['2001']);
          assert.equal((await f.database.rows('BaseItems', { where: { Id: movie.Id } }))[0].ProductionYear, 2000);
          assert.deepEqual(await linked(), beforeLinks);
          assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), originalBackend);
          const recovered = await f.library.queryYears({ parentId: aggregate.Id, recursive: false,
            includeItemTypes: ['Movie'], sortBy: ['Name'] }, { signal: t.signal });
          assert.deepEqual(recovered, selected);
          assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), originalBackend);
        });
      })));
}));

test('Years creates all 130 distinct names before Limit=0 and streams its later sorted response in actual SQL pages of at most 128', {
  skip: !enabled, timeout: 90000,
}, t => owned(t, async f => {
  await f.seed({ target: 'root', items: [...roots(), ...Array.from({ length: 130 }, (_, index) => ({
    key: 'movie-' + index, type: 'Movie', Id: id(index + 100), parent: 'root', ProductionYear: 1900 + index, MediaType: 'Video',
  }))] });
  t.signal.throwIfAborted();
  const output = path.join(validationOutputRoot(), 'years-list-pages-' + randomUUID()); await mkdir(output, { recursive: true });
  const report = { nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Real complete LibraryService Years traversal, by-name commits/directories, public count/window and actual bounded SQL result pages. TEMP disappearance and physical backend recovery precede fixture teardown.', pages: [] };
  await f.store.run(async db => {
    const before = await temporary(db), originalBackend = await backend(db), query = db.client.query.bind(db.client);
    db.client.query = async (...args) => {
      const result = await query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (typeof text === 'string' && /^\s*SELECT\b/u.test(text) && /mm_year_(?:order|winners|occurrences|queue|values)_/u.test(text)
        && /\bLIMIT 128\b/u.test(text)) {
        assert.ok(result.rows.length <= 128, 'Actual source/output SQL page exceeded the retained 128-item bound.');
        report.pages.push({ returned: result.rows.length });
      }
      return result;
    };
    try {
      const input = { parentId: id(2), recursive: false, includeItemTypes: ['Movie'], sortBy: ['Name'] };
      const cold = await observeExecutionPhase('postgres.years.cold-zero-limit', () => f.library.queryYears({ ...input, limit: 0 }, { signal: t.signal }),
        { fixture: 'tests/library/year-list-postgres.test.js' });
      t.signal.throwIfAborted();
      assert.deepEqual(cold, { Items: [], TotalRecordCount: 130, StartIndex: 0 });
      const rows = await yearRows(f); assert.equal(rows.length, 130);
      for (const row of rows) assert.equal((await stat(nativeYearIdentity(row.Name, f.library.options).Path)).isDirectory(), true);
      assert.deepEqual(await temporary(db), before);
      const all = await f.library.queryYears(input, { signal: t.signal });
      assert.equal(all.TotalRecordCount, 130); assert.equal(all.Items.length, 130);
      assert.deepEqual(all.Items.map(item => item.Name), Array.from({ length: 130 }, (_, index) => String(1900 + index)));
      const page = await f.library.queryYears({ ...input, sortOrder: ['Descending'], startIndex: 2, limit: 3 }, { signal: t.signal });
      assert.deepEqual(page.Items.map(item => item.Name), ['2027', '2026', '2025']); assert.equal(page.StartIndex, 2); assert.equal(page.TotalRecordCount, 130);
      const negative = await f.library.queryYears({ ...input, startIndex: -2, limit: -1 }, { signal: t.signal });
      assert.deepEqual(negative, { Items: [], TotalRecordCount: 130, StartIndex: -2 });
      assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), originalBackend);
      assert.deepEqual(await yearRows(f), rows);
      assert.ok(report.pages.some(page => page.returned === 128), 'The complete response never exercised a full retained SQL page.');
      report.backendRecovered = originalBackend; report.committedYears = rows.map(row => row.Name).sort();
      report.publicWindow = page;
    } finally { db.client.query = query; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
  });
}));

test('Years retains the committed factory prefix on a falsy failure and releases SQL/cohort ownership before same-backend recovery', {
  skip: !enabled, timeout: 60000,
}, t => owned(t, async f => {
  await f.seed({ target: 'root', items: [...roots(), ...Array.from({ length: 4 }, (_, index) => ({
    key: 'movie-' + index, type: 'Movie', Id: id(index + 100), parent: 'root', ProductionYear: 1900 + index, MediaType: 'Video',
  }))] });
  t.signal.throwIfAborted();
  await f.store.run(async db => {
    const before = await temporary(db), originalBackend = await backend(db), getYear = f.library.getYear;
    const marker = undefined;
    f.library.getYear = async function (year) {
      const item = await getYear.call(this, year);
      if (year === 1902) throw marker;
      return item;
    };
    let failed;
    try { failed = await outcome(f.library.queryYears({ parentId: id(2), recursive: false, limit: 0 }, { signal: t.signal })); }
    finally { f.library.getYear = getYear; }
    assert.equal(failed.failed, true); assert.equal(failed.reason, marker);
    assert.deepEqual((await yearRows(f)).map(row => row.Name).sort(), ['1900', '1901', '1902']);
    assert.equal((await stat(nativeYearIdentity('1902', f.library.options).Path)).isDirectory(), true);
    assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: nativeYearIdentity('1903', f.library.options).Id } }), []);
    assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), originalBackend);
    const recovered = await f.library.queryYears({ parentId: id(2), recursive: false, sortBy: ['Name'] }, { signal: t.signal });
    assert.deepEqual(recovered.Items.map(item => item.Name), ['1900', '1901', '1902', '1903']);
    assert.equal(recovered.TotalRecordCount, 4);
    assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), originalBackend);
    assert.deepEqual((await db.client.query('SELECT 1 AS recovered')).rows, [{ recovered: 1 }]);
  });
}));
