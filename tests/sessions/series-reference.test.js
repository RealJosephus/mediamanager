import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/index.js';
import { mapRecord, idKey, EMPTY_ID } from '../../src/library/records.js';
import { resolveSeries, resolveSeriesAsync } from '../../src/library/series-reference.js';
import { userDataKeys, hydrateItem, readUserDataRows } from '../../src/sessions/user-data.js';
import { seedSeriesReference, setSeriesCase, seriesUserId } from './series-reference-scenario.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fullJson = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? { $integer: String(entry) } : entry, 2) + '\n';
const fixtureBytes = await readFile(new URL('./fixtures/series-reference/native.json', import.meta.url));
assert.equal(hash(fixtureBytes), '824a0a64ed4b0680240d7f24aaeb44a448dd989df05bb56c8ba78253161733a2');
const native = JSON.parse(fixtureBytes), raw = native.raw;
const guid = value => value == null ? null : idKey(value);

test('Series contract pins actual DLL getters, keys, ignored JSON aliases and source/DLL inputs', async () => {
  assert.equal(native.sourceBindings.length, 22); assert.equal(native.nativeProcessExit, 0);
  assert.equal(raw.getters.length, 12); assert.equal(raw.sql.length, 7);
  assert.equal(raw.actualFrozenEpisodeSeasonGetters, true); assert.equal(raw.actualFrozenApplyOrderSqlTranslation, true);
  assert.equal(raw.dependenciesControlled, true); assert.equal(raw.databaseOpened, false);
  assert.equal(raw.sharedPostgresUsed, false); assert.equal(raw.portOpened, false);
  const oracleHash = hash(await readFile(new URL('./fixtures/series-reference/Oracle.cs', import.meta.url)));
  assert.equal(oracleHash, native.oracleSourceSha256);
  assert.equal(native.sourceBindings.find(entry => entry.path.endsWith('/Program.cs')).sha256, oracleHash);
  const actualKeys = raw.getters.filter(entry => ['wrong-type-explicit', 'missing-explicit'].includes(entry.mode));
  for (const entry of actualKeys) {
    assert.equal(entry.actualSeriesId, null); assert.deepEqual(entry.userDataKeys, [entry.Id]);
    assert.notEqual(entry.foundParentSeriesId, EMPTY_ID, 'explicit SeriesId failure does not reuse the real Series parent');
  }
  assert.equal(raw.ignoredAlias.SeriesId, EMPTY_ID);
  assert.deepEqual(JSON.parse(raw.ignoredAlias.serializedData).Series,
    { Id: raw.parentItems[1].Id, Type: 'Series', ProviderIds: { Tvdb: 'serialized-fake-key' } });
  assert.equal(raw.ignoredAlias.actualSeriesId, raw.parentItems[0].Id);
  for (const entry of native.sourceBindings.filter(entry => entry.path.endsWith('.dll') && !entry.path.endsWith('/e_sqlite3.dll'))) {
    const name = path.basename(entry.path, '.dll');
    assert.equal(raw.loadedAssemblies.find(assembly => assembly.name === name).sha256, entry.sha256);
  }
});

test('postgres: persisted typed Series resolution and complete user data keys match 12 DLL getter cases plus ignored JSON control', async () => {
    const schema = `series_reference_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
    const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    const store = new DomainStore(db), library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'series-getter-test' });
    const user = { Id: seriesUserId.toUpperCase(), Policy: { IsAdministrator: true, EnableAllFolders: true } };
    const result = { dialect: 'postgres', fixtureSha256: hash(fixtureBytes), passed: false, cleanup: {}, observations: [] };
    const snapshot = async () => ({ items: await db.rows('BaseItems'), providers: await db.rows('BaseItemProviders'),
      ancestors: await db.rows('AncestorIds'), userData: await db.rows('UserData') });
    const lookup = async id => {
      const row = (await db.rows('BaseItems', { where: { Id: String(id).toUpperCase() } }))[0];
      return row ? hydrateItem(db, row) : null;
    };
    const loadState = async () => library.load(db, user, { baseRows: await db.rows('BaseItems') });
    try {
      await seedSeriesReference(db, raw);
      for (const entry of [...raw.getters, { ...raw.ignoredAlias, type: 'Episode', mode: 'ignored-json-alias' }]) {
        const hydrated = await setSeriesCase(db, entry), before = await snapshot();
        assert.equal(guid(hydrated.ParentId ?? EMPTY_ID), guid(entry.ParentId));
        assert.equal(guid(hydrated.SeriesId ?? EMPTY_ID), guid(entry.SeriesId));
        assert.equal(hydrated.ParentIndexNumber, entry.ParentIndexNumber);
        assert.equal(hydrated.IndexNumber, entry.IndexNumber);
        assert.equal(Object.hasOwn(hydrated, 'Series'), false, 'hydration ignores persisted getter aliases');
        const storedRow = (await db.rows('BaseItems', { where: { Id: hydrated.Id } }))[0];
        const mapped = mapRecord(storedRow);
        assert.equal(Object.hasOwn(mapped, 'Series'), false, 'DAO canonicalization ignores persisted getter aliases');
        const plain = { ...hydrated, SeriesId: entry.SeriesId };
        const asyncSeries = await resolveSeriesAsync(plain, lookup);
        const state = await loadState();
        try {
          const canonical = state.byId.get(idKey(entry.Id));
          const syncSeries = resolveSeries(canonical, state.byId);
          assert.equal(guid(asyncSeries?.Id), guid(entry.actualSeriesId));
          assert.equal(guid(syncSeries?.Id), guid(entry.actualSeriesId));
          const storedAncestors = before.ancestors.filter(row => guid(row.ItemId) === guid(entry.Id)).map(row => guid(row.ParentItemId));
          assert.deepEqual(storedAncestors.sort(), raw.getters[0].savedAncestorIds.map(idKey).sort(), 'contradictory persisted ancestors stay intact');
          const persistedKeys = await userDataKeys(db, hydrated), domainKeys = await userDataKeys(db, plain);
          assert.deepEqual(persistedKeys, entry.userDataKeys, `${entry.type}/${entry.mode}: SQL hydration`);
          assert.deepEqual(domainKeys, entry.userDataKeys, `${entry.type}/${entry.mode}: actual Guid.Empty domain input`);
          assert.equal(state.userData.get(idKey(entry.Id)).Key, entry.userDataKeys[0], 'LibraryService.load uses the evaluated typed getter');
          const rows = state.rowsFor(canonical), expectedRow = rows.find(row => row.CustomDataKey === entry.userDataKeys[0]);
          assert.ok(expectedRow); assert.equal(state.userData.get(idKey(entry.Id)).PlayCount, expectedRow.PlayCount);
          assert.equal((await readUserDataRows(db, canonical, rows)).Key, entry.userDataKeys[0]);
          const listed = await library.getUserDataList([{ item: canonical }], { user });
          assert.equal(listed.length, 1); assert.equal(listed[0].Key, entry.userDataKeys[0], 'explicit item branch uses typed getter too');
          assert.equal(listed[0].PlayCount, expectedRow.PlayCount);
          const after = await snapshot();
          assert.deepEqual(after, before, 'all reads preserve exact SQL rows, ancestors and JSON');
          result.observations.push({ type: entry.type, mode: entry.mode, persisted: storedRow,
            actualSeriesId: asyncSeries?.Id ?? null, persistedKeys, domainKeys,
            loadKey: state.userData.get(idKey(entry.Id)).Key, list: listed[0], unchanged: true,
            beforeStateSha256: hash(fullJson(before)), afterStateSha256: hash(fullJson(after)) });
        } finally { await state.dispose({ session: db }); }
      }

      const episode = await setSeriesCase(db, raw.getters[0]);
      const realSeries = await lookup(raw.parentItems[0].Id), wrongSeries = await lookup(raw.parentItems[3].Id);
      const beforeControls = await snapshot();
      result.domainControls = [];
      for (const [name, Series, expected] of [['evaluated-series', realSeries, raw.getters[0].userDataKeys],
        ['evaluated-null', null, [raw.getters[0].Id]], ['evaluated-undefined', undefined, [raw.getters[0].Id]],
        ['wrong-type', wrongSeries, [raw.getters[0].Id]]]) {
        const item = { ...episode, Series }, state = await loadState();
        try {
          assert.equal(resolveSeries(item, state.byId), name === 'evaluated-series' ? realSeries : null);
          assert.equal(await resolveSeriesAsync(item, () => assert.fail('resolved getter must not perform another lookup')),
            name === 'evaluated-series' ? realSeries : null);
          const keys = await userDataKeys(db, item); assert.deepEqual(keys, expected);
          result.domainControls.push({ name, keys });
        } finally { await state.dispose({ session: db }); }
      }
      // Even a null serialized alias is removed, so SQL hydration can evaluate its actual parent chain.
      await db.update('BaseItems', { Id: episode.Id }, { Data: '{"Series":null}', SeriesId: null });
      const nullAlias = await lookup(episode.Id);
      assert.equal(Object.hasOwn(nullAlias, 'Series'), false); assert.deepEqual(nullAlias.Data, {});
      assert.deepEqual(await userDataKeys(db, nullAlias), raw.getters[0].userDataKeys);
      assert.equal(Object.hasOwn(mapRecord((await db.rows('BaseItems', { where: { Id: episode.Id } }))[0]), 'Series'), false);
      const nullState = await loadState();
      try { assert.equal(nullState.userData.get(idKey(episode.Id)).Key, raw.getters[0].userDataKeys[0]); }
      finally { await nullState.dispose({ session: db }); }
      const afterControls = await snapshot();
      beforeControls.items.find(item => item.Id === episode.Id).Data = '{"Series":null}';
      beforeControls.items.find(item => item.Id === episode.Id).SeriesId = null;
      assert.deepEqual(afterControls, beforeControls, 'only explicitly seeded null-alias input changes');
      result.nullAlias = { keys: await userDataKeys(db, nullAlias), data: nullAlias.Data };
      result.passed = true;
    } finally {
      await library.close();
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
      const remaining = await db.client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)',
        [[schema, schema + '__mm']]);
      assert.deepEqual(remaining.rows, []); result.cleanup.schemasRemoved = true;
      await store.close();
      try { await db.rows('BaseItems'); }
      catch (error) { result.cleanup.probeError = { code: error.code, message: error.message }; }
      assert.match(result.cleanup.probeError?.message ?? '', /not open|closed|ended/iu);
      result.cleanup.databaseClosed = true;
      if (process.env.MEDIAMANAGER_SERIES_REFERENCE_EVIDENCE) {
        const output = path.resolve(process.env.MEDIAMANAGER_SERIES_REFERENCE_EVIDENCE);
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, 'postgres.json'), fullJson(result));
      }
    }
  });
