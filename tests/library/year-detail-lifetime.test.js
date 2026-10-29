import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { nativeYearIdentity } from '../../src/library/year-identity.js';
import { idKey } from '../../src/library/records.js';
import { quoteIdentifier as q } from '../../src/database/model.js';

export const requiredValidationServices = ['postgres'];
const outcome = promise => promise.then(value => ({ failed: false, value }), error => ({ failed: true, error }));

test('Year detail commits the by-name entity before deferred user lookup fails and permits a later complete DTO', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const f = await setupChildrenFixture(t), added = [];
  f.library.on('ItemAdded', ({ Item }) => { if (Item.Type === 'Year') added.push(idKey(Item.Id)); });
  for (const [index, reason] of [false, 0, '', null, undefined].entries()) await t.test('reason ' + index, async () => {
    const year = 2040 + index, identity = nativeYearIdentity(String(year), f.library.options);
    assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: identity.Id } }), []);
    const failed = await outcome(f.library.getYearDto(year, { resolveUser: async () => {
      const rows = await f.database.rows('BaseItems', { where: { Id: identity.Id } });
      assert.equal(rows.length, 1); assert.equal(rows[0].Name, String(year));
      assert.equal((await stat(identity.Path)).isDirectory(), true);
      assert.ok(added.includes(idKey(identity.Id)));
      throw reason;
    } }));
    assert.equal(failed.failed, true); assert.ok(Object.is(failed.error, reason));
    const before = await f.database.rows('BaseItems', { where: { Id: identity.Id } });
    const dto = await f.library.getYearDto(year, { resolveUser: async () => null });
    assert.equal(dto.Id, idKey(identity.Id)); assert.equal(dto.Name, String(year)); assert.equal(dto.Type, 'Year');
    assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: identity.Id } }), before);
    assert.deepEqual(added.filter(id => id === idKey(identity.Id)), [idKey(identity.Id)]);
  });
});

test('a real PostgreSQL user lookup failure preserves the committed Year row and directory', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const f = await setupChildrenFixture(t), identity = nativeYearIdentity('2050', f.library.options);
  const result = await outcome(f.library.getYearDto(2050, { resolveUser: () => f.store.run(db => db.client.query(
    `SELECT "MissingYearUserLookupField" FROM ${q(db.schemaName)}."Users"`)) }));
  assert.equal(result.failed, true); assert.equal(result.error.code, '42703');
  const rows = await f.database.rows('BaseItems', { where: { Id: identity.Id } });
  assert.equal(rows.length, 1); assert.equal(rows[0].Name, '2050');
  assert.equal((await stat(identity.Path)).isDirectory(), true);
  assert.deepEqual(await f.database.client.query('SELECT 1 AS restored').then(result => result.rows), [{ restored: 1 }]);
  const dto = await f.library.getYearDto(2050);
  assert.equal(dto.Id, idKey(identity.Id)); assert.equal(dto.Name, '2050');
  assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: identity.Id } }), rows);
});
