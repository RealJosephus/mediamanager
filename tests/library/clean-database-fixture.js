import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { CleanDatabasePostScanTask } from '../../src/library/clean-database-post-scan-task.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeGuid } from '../../src/users/native.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, guid } from '../../src/library/records.js';
import { fixturePathStyle, projectStatePath, expandStatePath } from './fixture-state-path.js';

export const cleanupId = value => `ba420000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);
const rewrite = (value, transform) => Array.isArray(value) ? value.map(entry => rewrite(entry, transform))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, transform)]))
    : typeof value === 'string' ? transform(value) : value;

export async function setupDatabaseCleanup(t, observation) {
  const fixture = await setupChildrenFixture(t), { database, store, library } = fixture;
  useIdentityPathReversalControl(fixture);
  const sample = observation.sample, calls = [], progress = [], logs = [], abort = new AbortController();
  const metadataPath = path.join(fixture.stateRoot, 'metadata'), dataPath = path.join(fixture.stateRoot, 'data');
  const expand = text => expandStatePath(text, observation.root, fixture.stateRoot);
  const nativeRows = rows => rows.map(row => ({ ...rewrite(row, expand),
    Data: row.Data == null ? null : encode(rewrite(parseLosslessJson(row.Data), expand)) }));
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, rows] of [['BaseItems', nativeRows(observation.before.rows)], ['ItemValues', observation.before.values],
      ['ItemValuesMap', observation.before.maps]]) {
      const columns = tableDefinition(table).columns;
      for (const row of rows) await db.insert(table, Object.fromEntries(columns.map(column => [column.name,
        row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]])));
    }
  });
  fixture.vfs.mount({ path: '/cleanup-source', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: path.join(fixture.stateRoot, 'media'), accessRoot: '/cleanup-source/media', style: fixturePathStyle,
    returnAccess: 'Isolated cleanup media identities, accessed through VFS only.' });
  await fixture.adapter.mkdir('/media');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath, stateRoots: [dataPath] });
  for (const entry of [...observation.before.tree].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const identity = path.join(fixture.stateRoot, ...entry.path.split('/'));
    const location = await assets.resolve(identity);
    if (entry.directory) {
      if (location.localPath) await mkdir(location.localPath, { recursive: true });
      else await fixture.vfs.mkdir(location.accessPath, { recursive: true });
    } else {
      const text = entry.path.endsWith('internal.txt') ? 'internal' : entry.path.endsWith('data.bin') ? 'extracted'
        : entry.path.endsWith('.mkv') ? 'original media' : '#EXTM3U\n';
      const bytes = Buffer.from(text); assert.equal(sha(bytes), entry.sha256, entry.path);
      await assets.write(identity, bytes);
    }
  }
  const creator = new ItemCreationService(fixture); library.itemCreation = creator; t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath, metadataPath });
  const deletion = new ItemDeletionService({ ...fixture, itemCreation: creator, externalData: external,
    updates: fixture.host.updates, linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  library.itemDeletion = deletion;
  const cleaner = new CleanDatabasePostScanTask({ ...fixture, itemCreation: creator, itemDeletion: deletion, externalData: external,
    logger: Object.fromEntries(['debug', 'info', 'warn'].map(level => [level, message => logs.push({ level, message })])) });
  const snapshot = async () => {
    const normalizeRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      key === 'Data' && value != null ? rewrite(parseLosslessJson(value), text => projectStatePath(text, fixture.stateRoot, '$ROOT'))
        : key.startsWith('Date') && value != null ? dateText(value)
          : typeof value === 'string' ? projectStatePath(value, fixture.stateRoot, '$ROOT') : value])))
      .sort((a, b) => ordinal(a.Id, b.Id));
    const tree = [];
    const local = async directory => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const filename = path.join(directory, entry.name);
        tree.push({ path: path.relative(fixture.stateRoot, filename).replaceAll('\\', '/'), directory: entry.isDirectory(),
          sha256: entry.isDirectory() ? null : sha(await readFile(filename)) });
        if (entry.isDirectory()) await local(filename);
      }
    };
    await local(metadataPath); await local(dataPath);
    const network = async directory => {
      for (const entry of (await fixture.vfs.list(directory)).entries) {
        const filename = path.posix.join(directory, entry.name);
        let sha256 = null;
        if (entry.kind === 'file') {
          const handle = await fixture.vfs.openRead(filename);
          try { const chunks = []; for await (const part of handle.stream) chunks.push(Buffer.from(part)); sha256 = sha(Buffer.concat(chunks)); }
          finally { await handle.close(); }
        }
        tree.push({ path: filename.slice('/cleanup-source/'.length), directory: entry.kind === 'directory', sha256 });
        if (entry.kind === 'directory') await network(filename);
      }
    };
    await network('/cleanup-source/media');
    tree.sort((a, b) => ordinal(a.path, b.path));
    const values = (await database.rows('ItemValues')).sort((a, b) => ordinal(guid(a.ItemValueId), guid(b.ItemValueId)));
    const maps = (await database.rows('ItemValuesMap')).sort((a, b) => ordinal(guid(a.ItemId), guid(b.ItemId)));
    const normalizeIds = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      key.endsWith('Id') && typeof value === 'string' ? guid(value) : value])));
    return { rows: normalizeIds(normalizeRows(await database.rows('BaseItems'))), values: normalizeIds(values), maps: normalizeIds(maps), tree };
  };
  const normalizeNative = state => ({ ...state,
    rows: rewrite(state.rows, text => text.replaceAll(observation.root, '$ROOT')).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      key === 'Data' && value != null ? rewrite(parseLosslessJson(value), text => text.replaceAll(observation.root, '$ROOT'))
        : key.startsWith('Date') && value != null ? dateText(value) : value]))) });
  assert.deepEqual(await snapshot(), normalizeNative(observation.before), 'Independent initial database and filesystem frame.');
  if (sample.FailValues) {
    await database.client.query("CREATE FUNCTION cleanup_value_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled values failure'; END $$");
    await database.client.query('CREATE TRIGGER cleanup_value_failure BEFORE DELETE ON "ItemValues" FOR EACH ROW EXECUTE FUNCTION cleanup_value_failure()');
  }
  const select = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const query = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (query.includes('database-maintenance-dead')) {
      calls.push({ action: 'ids', HasDeadParentId: true });
      if (sample.FailSelection) throw Object.assign(new Error('Controlled selection failure'), { code: 'io' });
    }
    if (query.includes('database-maintenance-playlists')) {
      calls.push({ action: 'playlists', Recursive: true, kinds: [23] });
      if (sample.FailPlaylists) throw Object.assign(new Error('Controlled playlist selection failure'), { code: 'io' });
    }
    return select(...args);
  };
  const lookup = creator.getItemById.bind(creator);
  creator.getItemById = async id => {
    if (sample.FailLookup) throw Object.assign(new Error('Controlled lookup failure'), { code: 'io' });
    if (sample.NullLookup) return null;
    return lookup(id);
  };
  const extracted = external.paths.bind(external);
  external.paths = (item, loaded) => {
    // The task's early extraction is observed by its warning callback, while
    // ordinary DeleteItem invokes the same real path manager a second time.
    if (sample.FailExtracted) throw Object.assign(new Error('Controlled extracted path failure'), { code: 'io' });
    return extracted(item, loaded);
  };
  const removeExternal = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = async (item, options = {}) => {
    calls.push({ action: options.onError ? 'extracted' : 'external', id: guid(item.Id) });
    return removeExternal(item, options);
  };
  const remove = deletion.deleteItem.bind(deletion);
  deletion.deleteItem = async (item, options, parent, notifyParentItem) => {
    assert.equal(notifyParentItem, false);
    calls.push({ action: 'delete', id: guid(item.Id), DeleteFileLocation: options.DeleteFileLocation,
      DeleteFromExternalProvider: options.DeleteFromExternalProvider !== false });
    if (sample.FailDelete) throw Object.assign(new Error('Controlled delete failure'), { code: 'io' });
    const result = await remove(item, options, parent, notifyParentItem);
    if (sample.ChangeNextParent && guid(item.Id) === cleanupId(10)) {
      assert.equal(await database.update('BaseItems', { Id: nativeGuid(cleanupId(11)) }, { ParentId: nativeGuid(cleanupId(900)) }), 1n);
    }
    if (sample.CancelAfterDelete) abort.abort();
    return result;
  };
  const persist = deletion.deleteItems.bind(deletion);
  deletion.deleteItems = async (idsPlan, scope, publishDeletedPage) => {
    // Observe the same SQL-owned logical ID set before real persistence. The
    // fixture records the finite native call frame, without replacing deletion.
    const ids = [];
    let previous = '';
    for (;;) {
      const rows = (await scope.database.client.query({ text: `SELECT requested."Key" FROM (${idsPlan.text}) requested
        WHERE requested."Key" COLLATE "C" > $${idsPlan.values.length + 1} COLLATE "C"
        ORDER BY requested."Key" COLLATE "C" LIMIT 128`, values: [...idsPlan.values, previous] })).rows;
      for (const row of rows) ids.push(guid(row.Key));
      if (rows.length < 128) break;
      previous = rows.at(-1).Key;
    }
    calls.push({ action: 'persist', ids });
    return persist(idsPlan, scope, publishDeletedPage);
  };
  library.on('ItemRemoved', ({ Item, Parent }) => calls.push({ action: 'removed', id: guid(Item.Id), parent: Parent == null ? null : guid(Parent.Id) }));
  if (sample.CancelInitial) abort.abort();
  const operation = () => cleaner.run({ signal: abort.signal, reportProgress: value => {
    progress.push(value); if (sample.CancelValuesProgress && value === 60) abort.abort();
  } });
  return { ...fixture, creator, external, deletion, cleaner, assets, abort, calls, progress, logs, operation, snapshot, normalizeNative };
}
