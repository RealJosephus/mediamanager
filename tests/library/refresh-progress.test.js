import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/index.js';
import { nativePathWithin, sameNativePath } from '../../src/library/native-path.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { RefreshProgressNotifier } from '../../src/sessions/refresh-progress-notifier.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { EMPTY_ID, idKey } from '../../src/library/records.js';

const fixtureBytes = await readFile(new URL('./fixtures/refresh-progress/native.json', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(fixtureBytes), 'ddffb59ea4574b41e4fba0e65dbeda5151a24717e6b9aa3e023f1ec1149a2868');
const native = JSON.parse(fixtureBytes);

const ids = {
  physical: 'd1000000-0000-0000-0000-000000000003',
  collection: 'd1000000-0000-0000-0000-000000000004',
  nested: 'd1000000-0000-0000-0000-000000000005',
  posixPhysical: 'd1000000-0000-0000-0000-000000000006',
  cached: 'd1000000-0000-0000-0000-000000000009',
  second: 'd1000000-0000-0000-0000-000000000011',
  alias: 'd1000000-0000-0000-0000-000000000012'
};

test('refresh progress fixture binds actual native membership, cached getters and complete notifier payloads', async () => {
  assert.equal(native.sourceBindings.length, 18); assert.equal(native.nativeProcessExit, 0);
  assert.equal(native.raw.actualFrozenLibraryManagerMembership, true);
  assert.equal(native.raw.actualFrozenCollectionRefreshProgress, true); assert.equal(native.raw.actualFrozenNotifier, true);
  assert.equal(native.raw.dependenciesControlled, true); assert.equal(native.raw.databaseOpened, false);
  assert.equal(native.raw.actualWebSocketTransportInvoked, false); assert.equal(native.raw.phaseAcceptance, false);
  assert.equal(hash(await readFile(new URL('./fixtures/refresh-progress/Oracle.cs', import.meta.url))), native.oracleSourceSha256);
  assert.equal(native.sourceBindings.find(entry => entry.path.endsWith('/Program.cs')).sha256, native.oracleSourceSha256);
  assert.deepEqual(native.raw.ignoredAlias, { PhysicalLocationsList: [], PhysicalLocations: [], PhysicalFolderIds: [] });
  assert.deepEqual(JSON.parse(native.raw.inputs.find(entry => entry.Id === ids.alias).serializedData),
    { PhysicalLocations: ['Z:\\Refresh'] });
  assert.deepEqual(native.raw.output.map(entry => entry.getters.find(folder => folder.Id === ids.collection).progress),
    [null, null, null, null, null, null], 'path membership does not populate the physical ID cache, including own active progress');
  assert.deepEqual(native.raw.output.map(entry => entry.getters.find(folder => folder.Id === ids.cached).progress),
    [0, 40, 40, 20, 0, null], 'only physical folders with active progress contribute to the mean');
  const own = native.raw.output.find(entry => entry.phase === 'own-active-collection');
  assert.equal(own.own, 66); assert.deepEqual(own.ownProducerMessages, []);
  assert.equal(own.active.find(entry => entry.id === ids.collection).progress, 66);
});

test('native physical path comparison recognizes forward-slash UNC roots', () => {
  assert.equal(sameNativePath('\\\\Server\\Share\\Movies\\', '//server/share/movies'), true);
  assert.equal(sameNativePath('//server/share/Movies', '//server/share/Shows'), false);
  assert.equal(nativePathWithin('//SERVER/share/Movies/Child', '\\\\server\\share\\movies'), true);
  assert.equal(nativePathWithin('Z:\\Media Two', 'z:/Media'), false);
  assert.equal(nativePathWithin('/Media/Shows', '/media'), false);
});

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
}

function item(Id, Type, values = {}) {
  return { ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type,
    CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(), IsFolder: true, MediaType: 'Unknown', Data: '{}', ...values };
}

for (const dialect of ['postgres']) test(`${dialect}: refresh collection lookup and notifier match actual native root scope, exact OIC paths and cache progress`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const schema = `refresh_collection_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
    const database = await PostgresDatabase.open({ connectionString, schema, create: true });
    const store = new DomainStore(database);
    const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'refresh-collection-test' });
    const result = { dialect, nativeFixtureSha256: hash(fixtureBytes), passed: false, phaseAcceptance: false, cleanup: {} };
    try {
      for (const entry of native.raw.inputs) await database.insert('BaseItems', item(entry.Id, entry.type, {
        ParentId: entry.ParentId === '00000000-0000-0000-0000-000000000000' ? null : entry.ParentId,
        Path: entry.Path, TopParentId: entry.type === 'Folder' ? entry.Id : null,
        Data: entry.serializedData ?? (entry.type === 'CollectionFolder' ? JSON.stringify({ PhysicalLocationsList: entry.physicalLocationsList,
          PhysicalFolderIds: entry.physicalFolderIds }) : '{}')
      }));
      result.before = await database.rows('BaseItems');
      result.loadedInputs = [];
      for (const entry of native.raw.inputs) {
        const actual = await library.getItemRecord(entry.Id);
        assert.equal(actual.Type, entry.type); assert.equal(actual.Path, entry.Path);
        assert.equal(actual.ParentId ?? EMPTY_ID, entry.ParentId, 'persisted null parent maps to native Guid.Empty');
        if (entry.type === 'CollectionFolder') {
          assert.deepEqual(actual.PhysicalLocationsList ?? [], entry.physicalLocationsList);
          assert.deepEqual(actual.PhysicalFolderIds ?? [], entry.physicalFolderIds);
        }
        result.loadedInputs.push({ Id: actual.Id, Type: actual.Type, ParentId: actual.ParentId ?? EMPTY_ID, Path: actual.Path,
          ...(entry.type === 'CollectionFolder' ? { PhysicalLocationsList: actual.PhysicalLocationsList ?? [],
            PhysicalFolderIds: actual.PhysicalFolderIds ?? [] } : {}) });
      }
      const physical = await library.getItemRecord(ids.physical);
      const windowsFolders = await library.getCollectionFolders(physical);
      assert.deepEqual(windowsFolders.map(folder => folder.Id), native.raw.windowsCollectionIds,
        'case is ignored; forward/slash and trailing separators are not normalized; nested collections are outside root.Children');
      assert.equal(windowsFolders.some(folder => folder.Id === ids.nested), false);
      assert.equal(windowsFolders.some(folder => folder.Id === ids.alias), false,
        'the serialized PhysicalLocations alias is ignored by the native CollectionFolder getter');
      for (const folder of windowsFolders) {
        const input = native.raw.inputs.find(entry => entry.Id === folder.Id);
        assert.deepEqual(folder.PhysicalFolderIds, input.physicalFolderIds, 'lookup preserves the existing cache without adding IDs');
        assert.deepEqual(folder.PhysicalLocationsList, input.physicalLocationsList);
      }
      assert.deepEqual(windowsFolders.find(folder => folder.Id === ids.collection).PhysicalFolderIds, []);

      const posixPhysical = await library.getItemRecord(ids.posixPhysical);
      const posixFolders = await library.getCollectionFolders(posixPhysical);
      assert.deepEqual(posixFolders.map(folder => folder.Id), native.raw.posixCollectionIds,
        'membership uses OrdinalIgnoreCase for POSIX strings too, and a trailing separator remains different');
      const second = await library.getItemRecord(ids.second);
      const pathOnly = await library.getItemRecord(ids.collection);

      const refreshes = new ProviderRefreshService();
      const messages = [];
      let now = 0;
      const notifier = new RefreshProgressNotifier({
        refreshes,
        library,
        sessions: { async sendMessageToAdminSessions(messageType, data) { messages.push({ messageType, data }); } },
        clock: () => now
      });
      notifier.start();
      try {
        result.observations = [];
        const assertActive = entry => assert.deepEqual([...refreshes.snapshot()].sort(),
          entry.active.map(value => [idKey(value.id), value.progress]).sort(), `${entry.phase}: complete provider progress state`);
        for (const entry of native.raw.output.filter(entry => entry.phase !== 'own-active-collection')) {
          now += 1000;
          const start = messages.length;
          if (entry.phase === 'first-started') refreshes.reportStarted(physical);
          else if (entry.phase === 'first-progress') refreshes.reportProgress(physical, entry.progress);
          else if (entry.phase === 'second-started') refreshes.reportStarted(second);
          else if (entry.phase === 'first-completed') refreshes.reportCompleted(physical);
          else if (entry.phase === 'second-completed') refreshes.reportCompleted(second);
          else assert.fail(`Unrecognized native phase ${entry.phase}`);
          await notifier.drain();
          const phaseMessages = messages.slice(start);
          assert.deepEqual(phaseMessages, entry.messages, `${entry.phase}: complete native notifier MessageType/Data`);
          assertActive(entry);
          result.observations.push({ phase: entry.phase, messages: phaseMessages });
        }
        const own = native.raw.output.find(entry => entry.phase === 'own-active-collection');
        const collectionOffset = messages.length;
        refreshes.reportStarted(pathOnly); refreshes.reportProgress(pathOnly, own.own);
        await notifier.drain();
        assert.deepEqual(messages.slice(collectionOffset), own.ownProducerMessages,
          'a collection directly under the user root is not a top-parent refresh producer');
        refreshes.reportStarted(physical); await notifier.drain();
        now += 1000;
        const ownOffset = messages.length;
        refreshes.reportProgress(physical, own.progress); await notifier.drain();
        const ownMessages = messages.slice(ownOffset);
        assert.deepEqual(ownMessages, own.messages,
          'an empty CollectionFolder physical cache returns zero even when its own active provider progress is 66');
        assertActive(own);
        result.observations.push({ phase: own.phase, messages: ownMessages });
      } finally { await notifier.close(); }
      refreshes.reportCompleted(physical); refreshes.reportCompleted(pathOnly);
      assert.deepEqual([...refreshes.snapshot()], []);
      result.after = await database.rows('BaseItems');
      assert.deepEqual(result.after, result.before, 'lookup and notification do not mutate persisted item/cache fields');
      result.windowsCollectionIds = windowsFolders.map(folder => folder.Id);
      result.posixCollectionIds = posixFolders.map(folder => folder.Id);
      result.passed = true;
    } catch (error) {
      result.error = { name: error.name, message: error.message }; throw error;
    } finally {
      await library.close();
      if (dialect === 'postgres') {
        await database.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
        await database.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
        const remaining = await database.client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)',
          [[schema, schema + '__mm']]);
        assert.deepEqual(remaining.rows, []); result.cleanup.schemasRemoved = true;
      }
      await store.close();
      try { await database.rows('BaseItems'); }
      catch (error) { result.cleanup.databaseProbeError = { code: error.code, message: error.message }; }
      result.cleanup.databaseClosed = /not open|closed|ended/iu.test(result.cleanup.databaseProbeError?.message ?? '');
      assert.equal(result.cleanup.databaseClosed, true);
      if (process.env.MEDIAMANAGER_REFRESH_PROGRESS_EVIDENCE) {
        const destination = process.env.MEDIAMANAGER_REFRESH_PROGRESS_EVIDENCE;
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, `${dialect}.json`), stringifyNativeJson(result) + '\n', { flag: 'wx' });
      }
    }
  });
