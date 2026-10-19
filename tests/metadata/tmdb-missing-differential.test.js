import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { createTmdbMissingEpisodeProvider } from '../../plugins/tmdb/missing-episodes.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { persistedTmdbCleanupLifecycle, createTmdbTestServices } from './tmdb-missing-test-lifecycle.js';

const inputBytes = await readFile(new URL('./fixtures/tmdb-missing/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const provenance = JSON.parse(await readFile(new URL('./fixtures/tmdb-missing/provenance.json', import.meta.url)));
assert.equal(createHash('sha256').update(await readFile(new URL('../../tools/compat/record-tmdb-missing.mjs', import.meta.url)))
  .digest('hex'), provenance.recorderSha256);
for (const [filename, expected] of Object.entries(provenance.oracleFiles)) assert.equal(createHash('sha256')
  .update(await readFile(new URL(`./fixtures/tmdb-missing/${filename}`, import.meta.url))).digest('hex'), expected, filename);
const native = JSON.parse(await readFile(process.env.MEDIAMANAGER_TMDB_NATIVE_FIXTURE
  ? pathToFileURL(process.env.MEDIAMANAGER_TMDB_NATIVE_FIXTURE) : new URL('./fixtures/tmdb-missing/native.json', import.meta.url)));
if (!process.env.MEDIAMANAGER_TMDB_NATIVE_FIXTURE) assert.equal(createHash('sha256')
  .update(await readFile(new URL('./fixtures/tmdb-missing/native.json', import.meta.url))).digest('hex'), provenance.nativeSha256);
assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
assert.equal(native.phaseAcceptance, false);
const ids = Object.fromEntries(input.items.map((item, index) => [item.name, `f2222222-2222-2222-2222-${String(index + 1).padStart(12, '0')}`]));
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const baseItem = (name, type, values = {}) => ({ ...empty('BaseItems'), Id: ids[name], Name: name, SortName: name, Data: '{}',
  IsFolder: !['Episode'].includes(type), Type: `MediaBrowser.Controller.Entities.${['Series', 'Season', 'Episode'].includes(type) ? 'TV.' : ''}${type}`, ...values });

async function database(t, owned) {
  const schema = `tmdb_diff_${process.pid}_${randomBytes(5).toString('hex')}`;
  const db = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    await owned.services?.close();
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.schemaName)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.controlSchema)} CASCADE`);
    assert.equal((await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',
      [[db.schemaName, db.controlSchema]])).rows.length, 0);
    await db.close();
  });
  return db;
}

for (const dialect of ['postgres']) test(`${dialect}: TMDB missing cleanup matches actual DLL entity cases`, async t => {
  for (const sample of input.cases) await t.test(sample.name, async t => {
    const owned = {};
    const db = await database(t, owned), store = new DomainStore(db);
    for (const definition of input.items) {
      const data = { ...definition, ...sample.overrides?.[definition.name] };
      await db.insert('BaseItems', baseItem(data.name, data.type, { Path: data.path ?? null,
        ParentId: data.parent ? ids[data.parent] : null, TopParentId: data.topParent ? ids[data.topParent] : null,
        IsVirtualItem: data.virtual ?? false,
        Data: JSON.stringify({ PhysicalLocationsList: data.locations ?? [], PhysicalFolderIds: (data.physicalIds ?? []).map(name => ids[name]) }) }));
      if (data.provider) await db.insert('BaseItemProviders', { ItemId: ids[data.name], ProviderId: data.provider, ProviderValue: data.providerValue });
    }
    for (const [item, parent] of sample.ancestors ?? []) await db.insert('AncestorIds', { ItemId: ids[item], ParentItemId: ids[parent] });
    for (const [order, [parent, child]] of (sample.links ?? []).entries()) await db.insert('LinkedChildren', {
      ParentId: ids[parent], ChildId: ids[child], SortOrder: order, ChildType: 0 });
    await db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: 'f2222222-2222-2222-2222-000000000099',
      ItemId: ids.owned, ImageType: 0, Path: 'https://images.invalid/owned.jpg' });
    owned.services = await createTmdbTestServices({ store, serverId: 'tmdb-diff', vfs: {}, identityMap: {
      resolve: () => '/fixture/series',
    } });
    const load = owned.services.loadContext;
    const loaded = await load(ids.series);
    const expected = native.results.find(result => result.name === sample.name);
    assert.deepEqual(loaded.context.collectionFolderIds, expected.collectionFolders);
    const configuration = tmdbConfiguration({ ...sample.configuration, EnabledMissingEpisodeLibraries: (sample.enabled ?? []).map(name => {
      const value = ids[name];
      return sample.enabledFormat === 'hyphenated' ? value : sample.enabledFormat === 'uppercase' ? value.replaceAll('-', '').toUpperCase() : value.replaceAll('-', '');
    }) });
    const activeMarker = new Error('active import intentionally excluded from frozen disabled fixture');
    const provider = createTmdbMissingEpisodeProvider({ configuration, series: async () => { throw activeMarker; } });
    const lifecycle = persistedTmdbCleanupLifecycle(owned.services);
    assert.equal(provider.hasChanged(loaded.item, loaded.context), expected.hasChanged);
    // Two enabled samples compare selection and real membership only. Native
    // active FetchAsync is explicitly outside this recording's scope.
    if (expected.activeImportExcluded) {
      const before = await db.rows('BaseItems');
      await assert.rejects(provider.fetch(loaded.item, { ...loaded.context, lifecycle }), activeMarker);
      assert.deepEqual(await db.rows('BaseItems'), before);
      return;
    }
    const actual = await provider.fetch(loaded.item, { ...loaded.context, lifecycle,
      signal: sample.cancelled ? AbortSignal.abort(new Error('Fixture cancellation')) : undefined });
    assert.equal(actual.UpdateType, expected.updateType);
    assert.deepEqual(actual.RemovedItemIds, expected.removed);
    const remaining = new Set((await db.rows('BaseItems')).map(item => item.Id));
    for (const definition of input.items) assert.equal(remaining.has(ids[definition.name]), !expected.removed.includes(ids[definition.name]));
    assert.equal((await db.rows('BaseItemImageInfos', { where: { ItemId: ids.owned } })).length, expected.removed.includes(ids.owned) ? 0 : 1);
    for (const row of await db.rows('LinkedChildren')) assert.equal(expected.removed.includes(row.ParentId) || expected.removed.includes(row.ChildId), false);
    for (const row of await db.rows('BaseItemProviders')) assert.equal(expected.removed.includes(row.ItemId), false);
  });
});

test('TMDB HasChanged keeps native selection independent of active library configuration', () => {
  for (const sample of input.monitorCases) {
    const provider = createTmdbMissingEpisodeProvider({ configuration: sample.configuration });
    assert.equal(provider.hasChanged({ Type: sample.type, ProviderIds: { Tmdb: sample.providerValue } }, { collectionFolderIds: [] }),
      native.monitors.find(result => result.name === sample.name).hasChanged, sample.name);
  }
});
