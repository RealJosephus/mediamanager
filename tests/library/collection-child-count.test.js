import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, EMPTY_ID } from '../../src/library/records.js';
import { stringifyNativeJson } from '../../src/core/json.js';

const bytes = await readFile(new URL('./fixtures/collection-child-count/native.json', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes), '0f8a3c0caf4364ccc126ebbc1465e917646ae3c462d59c4a2f0183be80f1faa0');
const native = JSON.parse(bytes);
assert.equal(native.sourceBindings.length, 19); assert.equal(native.nativeProcessExit, 0);
assert.equal(native.raw.actualFrozenFolderMethods, true); assert.equal(native.raw.actualFrozenCollectionFolder, true);
assert.equal(native.raw.dependenciesControlled, true); assert.equal(native.raw.actualFullDtoServiceInvoked, false);
assert.equal(native.raw.output.length, 4);
assert.equal(hash(await readFile(new URL('./fixtures/collection-child-count/Oracle.cs', import.meta.url))), native.oracleSourceSha256);
assert.equal(native.sourceBindings.find(entry => entry.path.endsWith('/Program.cs')).sha256, native.oracleSourceSha256);

const id = number => `99100000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const row = (Id, Type, values = {}) => ({ ...Object.fromEntries(tableDefinition('BaseItems').columns
  .filter(column => !column.generated).map(column => [column.name, column.nullable ? null
    : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0])),
  Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type, Data: '{}', IsFolder: Type !== 'Video', ...values });
const user = { Id: id(99), Username: 'SyntheticAudit', Configuration: {}, Policy: { EnableAllFolders: true } };
const snapshot = async db => ({ baseItems: await db.rows('BaseItems'), linkedChildren: await db.rows('LinkedChildren') });

async function compare(db, library, result) {
  await db.insert('BaseItems', row(id(2), 'UserRootFolder'));
  for (const source of native.raw.output[0].sources) await db.insert('BaseItems', row(source.Id, 'Video',
    { Name: source.Name, Path: source.Path, ParentId: null, OwnerId: null,
      IsVirtualItem: source.IsVirtualItem, PresentationUniqueKey: source.PresentationUniqueKey }));
  for (const entry of native.raw.output) {
    const Type = entry.type.split('.').at(-1);
    await db.insert('BaseItems', row(entry.Id, Type, { ParentId: id(2),
      Data: JSON.stringify(Type === 'CollectionFolder' ? { PhysicalFolderIds: entry.physicalFolderIds } : {}) }));
    for (const [index, link] of entry.links.entries()) await db.insert('LinkedChildren', {
      ParentId: entry.Id, ChildId: link.ItemId, ChildType: link.Type, SortOrder: index });
  }
  result.before = await snapshot(db);
  const state = await library.load(db, user, {
    includeUserData: false,
    baseRows: await db.rows('BaseItems'),
  });
  try {
  for (const source of native.raw.output[0].sources) {
    const actual = state.byId.get(idKey(source.Id));
    assert.equal(idKey(actual.ParentId ?? EMPTY_ID), idKey(source.ParentId));
    assert.equal(idKey(actual.OwnerId ?? EMPTY_ID), idKey(source.OwnerId));
    assert.equal(actual.PresentationUniqueKey, source.PresentationUniqueKey);
  }
  result.observations = [];
  for (const entry of native.raw.output) {
    const item = state.byId.get(idKey(entry.Id));
    assert.deepEqual(state.children(item).map(child => child.Id), entry.cachedChildren, 'cache contains no linked children');
    // This sealed oracle invokes Folder.GetChildCount and GetItems, not
    // DtoService's persisted-source batch, which counts raw relation rows.
    const children = await library.queryItems({ ParentId: item.Id, EnableUserData: false,
      EnableImages: false, Fields: [] }, { user, fromUserViewChildren: true });
    const count = children.TotalRecordCount;
    assert.equal(count, entry.childCount, `${entry.Id}: native entity child count`);
    assert.deepEqual(children.Items.map(child => child.Id), entry.itemIds.map(idKey));
    assert.equal(children.TotalRecordCount, entry.TotalRecordCount);
    const observation = { Id: entry.Id, childCount: count, cachedChildren: state.children(item).map(child => child.Id) };
    if (item.Type === 'CollectionFolder') {
      const anonymous = await library.queryItems({ ParentId: item.Id, EnableUserData: false,
        EnableImages: false, Fields: [] }, { fromUserViewChildren: true });
      assert.deepEqual(anonymous.Items.map(child => child.Id), entry.anonymousItemIds.map(idKey));
      assert.equal(anonymous.TotalRecordCount, entry.anonymousTotalRecordCount);
      observation.internalItemIds = children.Items.map(child => child.Id);
      observation.TotalRecordCount = children.TotalRecordCount;
      observation.anonymousItemIds = anonymous.Items.map(child => child.Id);
      observation.anonymousTotalRecordCount = anonymous.TotalRecordCount;
    }
    result.observations.push(observation);
  }
  result.after = await snapshot(db);
  assert.deepEqual(result.after, result.before, 'count/children projection does not mutate persisted rows');
  result.passed = true;
  } finally { await state.dispose(); }
}

for (const driver of ['postgres']) test(`real native CollectionFolder linked fallback and ID-distinct controls match ${driver}`,
  { skip: driver === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const schema = `cc_${randomUUID().replaceAll('-', '')}`;
    const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    const store = new DomainStore(db), library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'collection-count-regression', configuration: {} });
    await attachLibraryNavigation(library);
    const result = { driver, nativeFixtureSha256: hash(bytes), phaseAcceptance: false, passed: false,
      consumer: 'Frozen entity Folder.GetChildCount/GetItems; no DTO batch equivalence claim.',
      coldPersistedRelationsOnly: true,
      unmetPrerequisites: ['Unsaved link handles, legacy Path fallback, owned/alternate fallback and exact live alias ordering require a separate actual native generic-Folder capture.'],
      dtoBatchVerified: false, publicControllerLinkedItemsVerified: false, cleanup: {} };
    try { await compare(db, library, result); }
    catch (error) { result.error = { name: error.name, message: error.message }; throw error; }
    finally {
      await closeLibraryNavigation(library);
      if (driver === 'postgres') {
        await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
        await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
        const remaining = await db.client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)', [[schema, schema + '__mm']]);
        assert.deepEqual(remaining.rows, []); result.cleanup.schemasRemoved = true;
      }
      await store.close();
      try { await db.rows('BaseItems'); }
      catch (error) { result.cleanup.databaseProbeError = { code: error.code, message: error.message }; }
      result.cleanup.databaseClosed = /not open|closed|ended/iu.test(result.cleanup.databaseProbeError?.message ?? '');
      assert.equal(result.cleanup.databaseClosed, true);
      if (process.env.MEDIAMANAGER_COLLECTION_CHILD_COUNT_EVIDENCE) {
        const destination = process.env.MEDIAMANAGER_COLLECTION_CHILD_COUNT_EVIDENCE;
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, `${driver}.json`), stringifyNativeJson(result) + '\n', { flag: 'wx' });
      }
    }
  });
