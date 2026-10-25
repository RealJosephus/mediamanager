import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createTestRuntime } from '../helpers/runtime.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { saveMetadataItem } from '../../src/metadata/save-item.js';
import { localXmlSavePath } from '../../src/metadata/local-xml.js';
import { idKey } from '../../src/library/records.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const native = JSON.parse(await fs.readFile(new URL('./fixtures/local-xml-failure-pipeline/native.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const id = value => `cd310000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const previous = '<Item><LocalTitle>Old complete document</LocalTitle></Item>';

export async function runLocalXmlFailurePipeline(t, protocols, startActualAList) {
  const results = [], writes = [], schemas = [], services = [];
  let runtime, storage, webdav, alist, evidence;
  const retained = process.env.MM_XML_PIPELINE_EVIDENCE;
  // Register before the database helper: release runtime owners before its
  // schemas, and retain service cleanup even when runtime construction fails.
  t.after(async () => {
    const failures = [];
    for (const close of [() => runtime?.close(), () => storage?.close(), () => alist?.stop(), () => webdav?.stop(),
      () => !retained && evidence ? fs.rm(evidence, { recursive: true, force: true }) : undefined]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'XML pipeline cleanup failed.');
  });
  if (retained) await fs.mkdir(retained, { recursive: true });
  evidence = await fs.mkdtemp(path.join(retained ?? os.tmpdir(), `xml-production-pipeline-${protocols.join('-')}-`));
  const database = await createPostgresTestDatabase(t, 'xml_pipeline'); schemas.push(database.schemaName, database.controlSchema);
  const stateRoot = path.join(evidence, 'state'); await fs.mkdir(stateRoot);
  const spoolRoot = path.join(stateRoot, 'data', 'metadata-spool');
  storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter()); await storage.createInstance('empty', 'memory', {});
  webdav = await startActualWebDav({ evidenceDirectory: path.join(evidence, 'webdav') }); services.push('webdav');
  alist = protocols.includes('alist') ? await startActualAList({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, evidenceDirectory: path.join(evidence, 'alist') }) : null;
  if (alist) services.push('alist');
  storage.registerType('webdav', config => new WebDavAdapter(config, { resolveCredential: async () => webdav.authorization }));
  storage.registerType('alist', config => new AListAdapter(config, { resolveCredential: async () => alist.token }));
  const capabilities = { create: true, replace: true, mkdir: true };
  for (const [name, service] of [['webdav', webdav], ...(alist ? [['alist', alist]] : [])]) await storage.createInstance(name, name,
    { baseUrl: service.baseUrl, credentialRef: 'isolated', capabilities });
  const vfs = new VirtualFileSystem(storage);
  for (const protocol of ['webdav', ...(alist ? ['alist'] : [])]) vfs.mount({ path: '/' + protocol, instanceId: protocol,
    root: protocol === 'alist' ? '/Synthetic' : '/', capabilities });
  vfs.mount({ path: '/empty', instanceId: 'empty', capabilities: {} });
  vfs.mount({ path: '/state-empty', instanceId: 'empty', capabilities: {} });
  vfs.mount({ path: '/readonly', instanceId: 'webdav', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  for (const protocol of ['webdav', 'alist']) identityMap.addPrefix({ identityRoot: `Z:\\${protocol}`,
    accessRoot: '/' + protocol, style: 'windows', returnAccess: 'isolated actual XML pipeline' });
  identityMap.addPrefix({ identityRoot: 'Z:\\', accessRoot: '/empty', style: 'windows', returnAccess: 'known empty metadata ancestor' });
  const ignoreIdentityMap = new IdentityAccessMap();
  for (const prefix of identityMap.exportState().prefixes) ignoreIdentityMap.addPrefix(prefix);
  ignoreIdentityMap.addPrefix({ identityRoot: path.parse(stateRoot).root, accessRoot: '/state-empty',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'isolated state ancestor namespace' });
  const insert = (Id, Type, values = {}) => database.insert('BaseItems', postgresTestRow('BaseItems', { Id,
    Type: Type === 'Movie' || Type === 'BoxSet' ? 'MediaBrowser.Controller.Entities.Movies.' + Type : 'MediaBrowser.Controller.Entities.' + Type,
    Name: Type, IsFolder: Type !== 'Movie', DateLastRefreshed: '2026-10-09 00:00:00', DateLastSaved: '2026-10-09 00:00:00', Data: '{}', ...values }));
  await insert(id(10), 'AggregateFolder'); await insert(id(11), 'UserRootFolder');
  await insert(id(2), 'Movie', { Path: 'Z:\\NeutralMedia\\member.mkv' });
  const errors = [];
  runtime = await createTestRuntime({ database, vfs, identityMap, ignoreIdentityMap, programDataPath: stateRoot,
    configurationDirectoryPath: path.join(stateRoot, 'config'), serverId: 'ignored-xml-pipeline',
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, onError: error => errors.push({ message: error.message, code: error.code ?? null }) });

  let calls, activeLookup, activeMonitorPath;
  const monitor = runtime.libraryMonitor;
  assert.equal(runtime.metadataUpdates.monitor, monitor);
  const begin = monitor.reportFileSystemChangeBeginning.bind(monitor);
  const complete = monitor.reportFileSystemChangeComplete.bind(monitor);
  monitor.reportFileSystemChangeBeginning = filename => {
    assert.equal(filename, activeMonitorPath, 'The saver reports the current item identity.');
    calls.push({ action: 'monitor-begin' });
    return begin(filename);
  };
  monitor.reportFileSystemChangeComplete = (filename, refreshPath) => {
    assert.equal(filename, activeMonitorPath); assert.equal(refreshPath, false);
    calls.push({ action: 'monitor-complete', reset: refreshPath });
    return complete(filename, refreshPath);
  };
  runtime.metadataUpdates.logger = { error(error, message) { calls.push({ action: 'logger', message, error: error.message }); } };
  runtime.metadata.registry.register({ id: 'pipeline-control', name: 'Other', providers: [{ id: 'other', name: 'Other', kind: 'saver', itemTypes: ['BoxSet'],
    isEnabledFor: () => true, validateSave: async () => {}, save: async (_item, context) => calls.push({ action: 'other-saver', cancellable: context.signal != null }) }] });
  runtime.library.on('ItemUpdated', event => calls.push({ action: 'event', reason: event.UpdateReason }));
  const originalWrite = vfs.write.bind(vfs);
  vfs.write = async (destination, bytes, options) => {
    const observation = { destination, declaredSize: String(options.size), chunks: 0, bytes: 0, maxChunk: 0 };
    writes.push(observation);
    assert.equal(typeof bytes[Symbol.asyncIterator], 'function');
    async function* observed() { for await (const chunk of bytes) {
      observation.chunks++; observation.bytes += chunk.length; observation.maxChunk = Math.max(observation.maxChunk, chunk.length);
      assert.ok(chunk.length <= 8192); yield chunk;
    } }
    return originalWrite(destination, observed(), options);
  };
  let number = 100;
  async function prepareCase(protocol, fault) {
    const ownerId = id(number++), directory = protocol === 'local' ? path.join(stateRoot, 'data', 'collections', 'set-' + ownerId.slice(-3)) : `${protocol}-${ownerId.slice(-3)}`;
    const physical = protocol === 'local' ? directory : path.join((protocol === 'webdav' ? webdav : alist).media, directory);
    await fs.mkdir(physical, { recursive: true }); await fs.writeFile(path.join(physical, 'collection.xml'), previous);
    const itemPath = protocol === 'local' ? directory : `Z:\\${protocol}\\${directory}`;
    await insert(ownerId, 'BoxSet', { Path: itemPath, Name: 'Stored name', Overview: 'Stored overview', OfficialRating: 'PG',
      DateCreated: '2026-10-13 00:00:00', Data: '{"DisplayOrder":"PremiereDate"}' });
    await database.insert('LinkedChildren', postgresTestRow('LinkedChildren', { ParentId: ownerId, ChildId: id(2), SortOrder: 0, ChildType: 0 }));
    const loaded = await runtime.metadata.loadContext(ownerId);
    assert.equal(loaded.context.spoolRoot, await fs.realpath(spoolRoot));
    loaded.libraryOptions = { MetadataSavers: ['Emby Xml', 'Other'] };
    const getPeople = loaded.context.getPeople;
    loaded.context.getPeople = async current => {
      calls.push({ action: 'people', length: (await fs.stat(path.join(physical, 'collection.xml'))).size });
      activeLookup = fault === 'people' ? 'people' : null;
      try { return await getPeople(current); } finally { activeLookup = null; }
    };
    loaded.context.prepareLinkedXmlItems = async current => {
      calls.push({ action: 'linked-items', length: (await fs.stat(path.join(physical, 'collection.xml'))).size });
      activeLookup = fault === 'links' ? 'links' : null;
      try {
        const result = await runtime.linkedChildren.xmlPaths(current.LinkedChildren, { parentId: current.Id, expandPath: loaded.context.expandPath });
        return { manualCount: result.manualCount, pages: options => result.paths.pages(options), close: () => runtime.linkedChildren.release(result.paths) };
      } finally { activeLookup = null; }
    };
    loaded.item.Name = 'New common title';
    loaded.item.Overview = fault === 'xml' ? 'Before \0 after' : fault === 'xml-control' ? 'Before \u0001 after' : 'New overview';
    return { loaded, physical, ownerId };
  }
  for (const protocol of protocols) for (const fault of ['links', 'people', 'xml-control', 'none', 'xml']) await t.test(protocol + '/' + fault, async () => {
    calls = []; const h = await prepareCase(protocol, fault), writeStart = writes.length;
    activeMonitorPath = localXmlSavePath(h.loaded.item);
    const query = database.client.query.bind(database.client);
    database.client.query = (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (activeLookup === 'people' && /"PeopleBaseItemMap"/u.test(text)) throw new Error('Controlled people lookup failure');
      if (activeLookup === 'links' && /"BaseItems"/u.test(text)) throw new Error('Controlled linked-item lookup failure');
      if (/^UPDATE .*"BaseItems"/u.test(text)) calls.push({ action: 'save', cancellable: false });
      return query(...args);
    };
    let failure, saves;
    try { saves = await saveMetadataItem(runtime.metadataUpdates, h.loaded, { Item: h.loaded.item, Images: [] }, 16); }
    catch (error) { failure = error; }
    finally { database.client.query = query; await h.loaded.dispose(); }
    const row = (await database.rows('BaseItems', { where: { Id: h.ownerId } }))[0];
    const bytes = await fs.readFile(path.join(h.physical, 'collection.xml'));
    const expected = native.results.find(value => value.fault === fault);
    assert.equal(bytes.length, expected.fileBytes); assert.equal(sha(bytes), expected.fileSha256);
    assert.deepEqual(await fs.readdir(spoolRoot), []);
    if (protocol !== 'local') assert.equal(writes.length - writeStart, 1, 'one frame upload on success or preparation failure');
    const projected = calls.map(call => call.action), expectedActions = expected.calls.map(call => call.action);
    assert.equal(failure, undefined); assert.equal(row.Name, expected.storedName); assert.equal(row.Overview, expected.storedOverview);
    assert.equal((await database.rows('LinkedChildren', { where: { ParentId: h.ownerId } })).length, expected.storedLinkedChildren);
    assert.deepEqual(projected, expectedActions); assert.ok(row.DateLastSaved); assert.equal(saves.filter(value => value.error).length, fault === 'none' ? 0 : 1);

    results.push({ protocol, fault, calls, fileBytes: bytes.length, fileSha256: sha(bytes), storedName: row.Name, storedOverview: row.Overview,
      exception: failure ? { message: failure.message, code: failure.code ?? null } : null,
      nativePersistenceMatches: true, nulProductionPersistenceUnresolved: false,
      uploadCount: writes.length - writeStart, capturedEarlyLookupWindowMatches: protocol === 'local',
      completeMetadataRefreshExecuted: false });
  });
  await t.test('real metadata scan consumer continues after a caught saver failure', async () => {
    calls = [];
    const first = await prepareCase('webdav', 'links'), second = await prepareCase('webdav', 'none');
    const frames = new Map([[first.ownerId, first.loaded], [second.ownerId, second.loaded]]);
    const query = database.client.query.bind(database.client);
    database.client.query = (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (activeLookup === 'links' && /"BaseItems"/u.test(text)) throw new Error('Controlled linked-item lookup failure');
      return query(...args);
    };
    const saveResults = [];
    runtime.configuration.LibraryScanFanoutConcurrency = 1;
    const scanner = new LibraryMetadataScanService({ library: runtime.library, scheduler: runtime.libraryTaskScheduler,
      metadata: { validateRefresh() {}, async refreshLiveItem(reference) {
        const loaded = frames.get(reference.Id);
        activeMonitorPath = localXmlSavePath(loaded.item);
        let Saves; try { Saves = await saveMetadataItem(runtime.metadataUpdates, loaded, { Item: loaded.item, Images: [] }, 16); } finally { await loaded.dispose(); }
        saveResults.push(Saves);
        return { changed: true, UpdateType: 16, Failures: 0, Saves };
      } } });
    const cohort = await createNativeItemCohort({ linkedChildren: runtime.library.options.linkedChildren });
    const children = metadataChildSequence(cohort, runtime.library.options.linkedChildren, runtime.store);
    let receipt;
    try {
      await cohort.capture(first.loaded.item, { ordinal: 1n });
      await cohort.capture(second.loaded.item, { ordinal: 2n });
      receipt = await scanner.refreshAccessibleChildren(children, {}, { recursive: false });
    }
    finally { database.client.query = query; await children.close(); for (const loaded of frames.values()) await loaded.dispose(); }
    assert.deepEqual(receipt, { attemptedCount: 2, updatedCount: 2, providerFailures: 0, errors: [], cancelled: false });
    assert.equal(calls.filter(value => value.action === 'event').length, 2);
    assert.equal(saveResults[0].filter(value => value.error).length, 1);
    assert.equal(saveResults[1].filter(value => value.error).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: second.ownerId } }))[0].Name, 'New common title');
    results.push({ check: 'actual-metadata-scan-consumer', receipt, actualUpdateAndPersistence: true, refreshEntryAdapterControlled: true });
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(await fs.readdir(spoolRoot), []);
  await fs.writeFile(path.join(evidence, 'observations.json'), JSON.stringify({ results, writes, schemas, services,
    boundedPageSize: 128, sourceSerializerBounded: true, actualNodePostgresPersistence: true, actualSaveMetadataItem: true,
    actualMetadataUpdateHost: true, actualSaveManager: true, actualScanConsumer: results.some(result => result.check === 'actual-metadata-scan-consumer'),
    productionIntegrated: false, phaseAcceptance: false, sharedPostgres15442Used: false }, null, 2) + '\n');
}
