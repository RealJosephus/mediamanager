import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { loadLibrary, idKey, EMPTY_ID } from '../../src/library/records.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { stringifyNativeJson } from '../../src/core/json.js';

const fixturePath = new URL('./fixtures/dto-parent-id/native.json', import.meta.url);
const bytes = await readFile(fixturePath);
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes), '9c340922a3fa690794f13a74e13e4dbcdc8e2ad2c5496b2acecba8ce9ef0c7e9');
const native = JSON.parse(bytes);
assert.equal(native.result.length, 16);
assert.equal(native.sourceBindings.length, 19);
assert.deepEqual(native.verified, { nativeProcessExit: 0, actualFrozenBaseItemMapper: true,
  actualFrozenDisplayParentGetter: true, actualFrozenNullableGuidSerializer: true,
  explicitPersistedGuidAssignment: true, actualFullDtoServiceInvoked: false });
assert.equal(hash(await readFile(new URL('./fixtures/dto-parent-id/Oracle.cs', import.meta.url))), native.oracleSourceSha256);
assert.equal(native.sourceBindings.find(entry => entry.path.endsWith('/Program.cs')).sha256, native.oracleSourceSha256);

const id = number => `99000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const row = (Id, Type, values = {}) => ({ ...Object.fromEntries(tableDefinition('BaseItems').columns
  .filter(column => !column.generated).map(column => [column.name, column.nullable ? null
    : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0])),
  Id, Type: `MediaBrowser.Controller.Entities.${['Episode', 'Season', 'Series'].includes(Type) ? 'TV.' : ''}${Type}`,
  Name: Type, Data: '{}', IsFolder: ['Folder', 'Season', 'Series', 'UserView'].includes(Type), ...values });

async function compare(db) {
  // All nullable FK values, including Guid.Empty, are real persisted values.
  // The synthetic referenced rows carry no media, permissions or credentials.
  for (const number of [1, 2, 3]) await db.insert('BaseItems', row(id(number), 'Folder'));
  await db.insert('BaseItems', row(EMPTY_ID, 'Folder'));
  for (const [index, { input }] of native.result.entries()) await db.insert('BaseItems', row(id(index + 10), input.Type,
    { ParentId: input.ParentId, SeasonId: input.SeasonId, SeriesId: input.SeriesId,
      Data: JSON.stringify({ DisplayParentId: input.DisplayParentId }) }));
  const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
  const output = [];
  for (const [index, entry] of native.result.entries()) {
    const item = state.byId.get(idKey(id(index + 10)));
    assert.equal(idKey(item.ParentId ?? EMPTY_ID), idKey(entry.mappedParentId), `${entry.input.Name}: persisted ParentId`);
    if (item.Type === 'Episode') assert.equal(idKey(item.SeasonId ?? EMPTY_ID), idKey(entry.mappedSeasonId), entry.input.Name);
    if (['Episode', 'Season'].includes(item.Type)) assert.equal(idKey(item.SeriesId ?? EMPTY_ID), idKey(entry.mappedSeriesId), entry.input.Name);
    if (item.Type === 'UserView') assert.equal(item.DisplayParentId, entry.hiddenViewDisplayParentId, entry.input.Name);
    const dto = JSON.parse(stringifyNativeJson(await projectItem(item, state, null,
      dtoOptions({ fields: ['ParentId'], enableuserdata: false, enableimages: false }), { serverId: 'parent-id-oracle' })));
    assert.equal(Object.hasOwn(dto, 'ParentId'), true, `${entry.input.Name}: selected field is present even when null`);
    output.push({ name: entry.input.Name, ParentId: dto.ParentId });
  }
  assert.deepEqual(output, native.result.map(entry => ({ name: entry.input.Name, ParentId: entry.dtoParentId })));
}

test('16 actual DLL mapper/getter ParentId observations match persisted PostgreSQL DTO projection',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const schema = `dto_parent_id_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    try { await compare(db); }
    finally {
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
      const result = await db.client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)', [[schema, schema + '__mm']]);
      assert.deepEqual(result.rows, []);
      await db.close();
      await assert.rejects(db.rows('BaseItems'), /closed|ended/iu);
    }
  });
