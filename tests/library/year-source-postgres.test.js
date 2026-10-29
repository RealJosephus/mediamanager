import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { createPostgresYearsSource } from '../../src/library/postgres-years-source.js';
import { cloneNativeItemEntity, newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { nativeYearIdentity } from '../../src/library/year-identity.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const id = number => '83700000-0000-0000-0000-' + String(number).padStart(12, '0');

async function temporaryRelations(db) {
  return (await db.client.query(`SELECT relname FROM pg_catalog.pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY relname`)).rows;
}

async function withSource(f, mode, operation) {
  return f.store.run(async db => {
    const before = await temporaryRelations(db);
    const source = await createPostgresYearsSource(db, { linkedChildren: f.linkedChildren, mode, includeItemTypes: ['Movie'] });
    try { return await operation(source); }
    finally { await source.close(); assert.deepEqual(await temporaryRelations(db), before); }
  });
}

test('Year source preserves occurrence totals, Guid winners and direct-list differences while committing actual by-name rows', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const f = await setupChildrenFixture(t);
  await f.seed({ target: 'first', items: [
    { key: 'first', type: 'Movie', Id: id(1), ProductionYear: 2020, MediaType: 'Video' },
    { key: 'second', type: 'Movie', Id: id(2), ProductionYear: 2021, MediaType: 'Video' },
  ] });
  const state = await f.state(), first = state.byId.get(f.idKey(id(1))), second = state.byId.get(f.idKey(id(2)));
  const later = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
  later.Id = first.Id; later.ProductionYear = 2022;
  t.after(() => releaseNativeItemLinks(later));
  const cases = [
    ['user-recursive', [2020, 2021], 2],
    ['user-direct', [2021], 1],
    ['userless-recursive', [2020, 2021], 2],
    ['userless-direct', [2020, 2021], 2],
  ];
  for (const [mode, expected, total] of cases) await t.test(mode, async () => {
    const created = [];
    await withSource(f, mode, async source => {
      await source.append([first, second, later], [[0n, 1n], [0n, 2n], [0n, 3n]], { frame: randomUUID(), visible: true });
      const extracted = await source.seal(async year => { await f.library.getYear(year); created.push(year); });
      assert.equal(extracted.total, total);
      const names = [];
      for (let after = 0n;;) {
        const page = await extracted.page(after);
        assert.ok(page.length <= 128);
        if (!page.length) break;
        names.push(...page.map(row => row.year)); after = page.at(-1).position;
      }
      assert.deepEqual(names, expected); assert.deepEqual(created, expected);
    });
    for (const year of expected) {
      const identity = nativeYearIdentity(String(year), f.library.options);
      assert.equal((await stat(identity.Path)).isDirectory(), true);
      const rows = await f.database.rows('BaseItems', { where: { Id: identity.Id } });
      assert.equal(rows.length, 1); assert.equal(rows[0].Name, String(year));
    }
  });
});

test('Year extraction reads later live production-year values after the preceding real by-name creation', {
  skip: !enabled, timeout: 60000,
}, async t => {
  const f = await setupChildrenFixture(t);
  await f.seed({ target: 'first', items: [
    { key: 'first', type: 'Movie', Id: id(1), ProductionYear: 2020, MediaType: 'Video' },
    { key: 'second', type: 'Movie', Id: id(2), ProductionYear: 2021, MediaType: 'Video' },
  ] });
  const state = await f.state(), first = state.byId.get(f.idKey(id(1))), second = state.byId.get(f.idKey(id(2)));
  const replacement = cloneNativeItemEntity(first);
  replacement.ProductionYear = 2022;
  t.after(() => releaseNativeItemLinks(replacement));
  const created = [];
  const listener = ({ Item }) => { if (Item.Type === 'Year' && Item.Name === '2022') second.ProductionYear = 2023; };
  f.library.on('ItemAdded', listener); t.after(() => f.library.off('ItemAdded', listener));
  await withSource(f, 'user-recursive', async source => {
    await source.append([first, second], [[0n, 1n], [0n, 2n]], { visible: true });
    await source.append([replacement], [[0n, 3n]], { visible: true });
    const result = await source.seal(async year => { await f.library.getYear(year); created.push(year); });
    assert.equal(result.total, 3); assert.deepEqual(created, [2022, 2023]);
  });
  for (const year of [2022, 2023]) {
    const identity = nativeYearIdentity(String(year), f.library.options);
    assert.equal((await stat(identity.Path)).isDirectory(), true);
    assert.equal((await f.database.rows('BaseItems', { where: { Id: identity.Id } }))[0].Name, String(year));
  }
  for (const year of [2020, 2021]) assert.deepEqual(await f.database.rows('BaseItems', {
    where: { Id: nativeYearIdentity(String(year), f.library.options).Id },
  }), []);
});

test('Year source drains more than one bounded page and releases its SQL/cohort owners after a by-name failure', {
  skip: !enabled, timeout: 90000,
}, async t => {
  const f = await setupChildrenFixture(t);
  await f.seed({ target: 'movie-1', items: Array.from({ length: 130 }, (_, index) => ({
    key: 'movie-' + (index + 1), type: 'Movie', Id: id(index + 1), ProductionYear: 1900 + index, MediaType: 'Video',
  })) });
  const state = await f.state(), items = state.items.filter(item => item.Type === 'Movie').sort((left, right) => left.ProductionYear - right.ProductionYear);
  const marker = undefined;
  await assert.rejects(withSource(f, 'userless-direct', async source => {
    for (let offset = 0; offset < items.length; offset += 128) await source.append(items.slice(offset, offset + 128),
      items.slice(offset, offset + 128).map((_, index) => [BigInt(offset + index + 1)]), { visible: true });
    await source.seal(async year => {
      if (year === 2028) throw marker;
      await f.library.getYear(year);
    });
  }), reason => Object.is(reason, marker));
  const first = nativeYearIdentity('1900', f.library.options), later = nativeYearIdentity('2028', f.library.options);
  assert.equal((await stat(first.Path)).isDirectory(), true);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: first.Id } })).length, 1);
  assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: later.Id } }), []);
  const recovered = await f.library.getYear(2028);
  assert.equal(recovered.Name, '2028'); assert.equal((await stat(later.Path)).isDirectory(), true);
  assert.deepEqual((await f.database.client.query('SELECT 1 AS recovered')).rows, [{ recovered: 1 }]);
});
