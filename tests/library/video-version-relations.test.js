import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { persistVideoVersionRelations } from '../../src/library/video-version-relations.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

const root = new URL('./fixtures/video-version-relations/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
    : column.type === 'TEXT' ? '' : column.type === 'BLOB' ? new Uint8Array() : column.clrType === 'long' ? 0n : 0]));
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const seedRows = sample => {
  const rows = structuredClone(input.common.rows);
  for (const change of sample.rows ?? []) {
    let row = rows.find(row => row.Id === change.Id);
    if (!row) { row = {}; rows.push(row); }
    Object.assign(row, change);
  }
  for (const row of rows) if (row.RunTimeTicks != null) row.RunTimeTicks = BigInt(row.RunTimeTicks);
  return rows;
};
const itemFor = sample => {
  const { Type, ...values } = { ...structuredClone(input.common.item), ...structuredClone(sample.item ?? {}) };
  const nativeType = Type === 'Audio' ? 'MediaBrowser.Controller.Entities.Audio.Audio'
    : 'MediaBrowser.Controller.Entities.Movies.Movie';
  return applyNativeItemValues(newNativeItemEntity(nativeType),
    { Genres: [], Studios: [], Tags: [], ProviderIds: {}, LockedFields: [] }, values);
};

test('video version relation oracle seals actual EF execution, sources, failure boundaries and exact Int64', async () => {
  for (const file of provenance.fixtureFiles) {
    const filename = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenVideoVersionRelations, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  assert.equal(native.results.length, 26);
  assert.equal(native.results[0].items.find(row => row.id === input.common.rows.find(row => row.RunTimeTicks).Id).runTimeTicks, 9007199254740995n);
  assert.deepEqual(native.results.map(row => row.exception), input.cases.map(row => row.expectException ?? null));
});

async function fixture(t, dialect, sample) {
  const schema = 'version_relations_' + randomUUID().replaceAll('-', '').slice(0, 18);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => {
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await store.close();
  });
  for (const row of seedRows(sample)) await database.insert('BaseItems', { ...blank('BaseItems'), ...row });
  for (const row of sample.links ?? []) await database.insert('LinkedChildren', row);
  for (const table of sample.tables ?? []) for (const row of table.rows) {
    const values = { ...blank(table.name), ...row };
    if (Array.isArray(values.KeyframeTicks)) values.KeyframeTicks = JSON.stringify(values.KeyframeTicks);
    await database.insert(table.name, values);
  }
  if (sample.trigger) {
    // EF stores Guid parameters in upper case; these controlled Node seeds
    // retain input spelling. Match the same identity in each raw SQL trigger.
    const trigger = sample.trigger.replace(/'([0-9A-F-]{36})'/gu, (_, value) => "'" + value.toLowerCase() + "'");
    const event = /AFTER (.+?) WHEN/u.exec(trigger)[1];
    const condition = /WHEN (.+?) BEGIN/u.exec(trigger)[1].replace(/\b(OLD|NEW)\.([A-Za-z]+)/gu, '$1."$2"');
    const table = / ON ([A-Za-z]+)/u.exec(event)[1], action = event.slice(0, event.indexOf(' ON '));
    const quotedAction = action.replace(/UPDATE OF ([A-Za-z]+)/u, 'UPDATE OF "$1"');
    await database.client.query(`CREATE FUNCTION "${schema}".fail_save() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Controlled version relation failure'; END $$`);
    await database.client.query(`CREATE TRIGGER fail_save AFTER ${quotedAction} ON "${schema}"."${table}"
      FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION "${schema}".fail_save()`);
  }
  return { database, store };
}

async function project(database, sample, exception) {
  const items = (await database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => ({
    id: row.Id.toLowerCase(), name: row.Name, path: row.Path, ownerId: row.OwnerId?.toLowerCase() ?? null,
    primaryVersionId: row.PrimaryVersionId?.toLowerCase() ?? null, presentationUniqueKey: row.PresentationUniqueKey,
    runTimeTicks: row.RunTimeTicks
  })).sort((a, b) => ordinal(a.id, b.id));
  const links = (await database.rows('LinkedChildren')).map(row => ({ parentId: row.ParentId.toLowerCase(),
    childId: row.ChildId.toLowerCase(), childType: row.ChildType, sortOrder: row.SortOrder }))
    .sort((a, b) => ordinal(a.parentId, b.parentId) || a.sortOrder - b.sortOrder);
  const tables = [];
  for (const table of sample.tables ?? []) {
    const rows = (await database.rows(table.name)).map(row => table.projection.map(column => row[column] == null ? null : String(row[column]).toLowerCase()))
      .sort((a, b) => ordinal(a.join('|'), b.join('|')));
    tables.push({ name: table.name, rows });
  }
  return { name: sample.name, exception, items, links, tables };
}

for (const dialect of ['postgres']) for (const sample of input.cases) for (const mode of ['relations', 'metadata']) {
  test(`${dialect}: native video version ${mode} ${sample.name}`,
    { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
      const { database, store } = await fixture(t, dialect, sample), item = itemFor(sample);
      const loaded = { item, snapshot: (await database.rows('BaseItems', { where: { Id: item.Id } }))[0], relationships: {},
        parents: [], collectionFolders: [], sortName: () => 'controlled-sort-name' };
      const cancellation = new AbortController();
      if (sample.cancelled) cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
      let exception = null;
      try {
        for (let iteration = 0; iteration < (sample.repeat ?? 1); iteration++) {
          if (mode === 'metadata') await persistMetadata(store, loaded, { Item: item }, { signal: cancellation.signal });
          else await store.transaction(async db => {
            cancellation.signal.throwIfAborted();
            await db.update('BaseItems', { Id: item.Id }, { Name: item.Name, Path: item.Path,
              PrimaryVersionId: item.PrimaryVersionId ?? null, PresentationUniqueKey: item.PresentationUniqueKey });
            await persistVideoVersionRelations(db, item);
          });
        }
      } catch (error) {
        if (error.nativeException) exception = error.nativeException;
        else {
          assert.ok(sample.expectException, error.stack);
          assert.ok(['23503', 'P0001'].includes(error.code), error.stack);
          exception = 'DbUpdateException';
        }
      }
      assert.deepEqual(await project(database, sample, exception), native.results.find(row => row.name === sample.name));
    });
}

for (const dialect of ['postgres']) test(`${dialect}: the version snapshot rejects external links without advancing the baseline`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await fixture.seed({ target: 'owner', items: [{ key: 'owner', type: 'Movie', Id: input.common.item.Id },
      { key: 'child', type: 'Movie', Id: input.common.rows[2].Id }] });
    const loaded = await fixture.loadContext(input.common.item.Id), baseline = structuredClone(loaded.versionLinks);
    await fixture.database.insert('LinkedChildren', { ParentId: loaded.item.Id, ChildId: input.common.rows[2].Id, ChildType: 3, SortOrder: 0 });
    const before = await fixture.database.rows('BaseItems'), links = await fixture.database.rows('LinkedChildren');
    loaded.item.Overview = 'Must not replace an external version relation';
    await assert.rejects(persistMetadata(fixture.store, loaded, { Item: loaded.item }), { code: 'metadata-conflict', status: 409 });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await fixture.database.rows('LinkedChildren'), links);
    assert.deepEqual(loaded.versionLinks, baseline);
  });
