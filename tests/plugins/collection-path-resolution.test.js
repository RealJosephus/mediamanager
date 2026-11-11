import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { newNativeItemEntity, publishNativeItemLinks, retainNativeItemLinks, releaseNativeItemLinks,
  observeNativeItemLinkOwnership } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000 };
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
const databaseFailure = value => value != null && (typeof value.code === 'string' && /^[0-9A-Z]{5}$/u.test(value.code)
  || /Client was closed|Connection terminated/u.test(value.message ?? '')
  || value.errors?.some(databaseFailure) || databaseFailure(value.cause));
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function deadline(operation, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, name) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, name + '-'));
  const work = path.join(root, 'instance'), programDataPath = path.join(work, 'program');
  const report = { backgroundErrors: [], cleanupErrors: [], observations: [] }, heldOwners = new Set();
  let database, runtime;
  t.after(async () => {
    for (const owner of heldOwners) try { owner.release(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
    try { await runtime?.collections.linkedChildren.flushReleases(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
    try { await runtime?.close(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); }
    await fs.writeFile(path.join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
    assert.deepEqual(report.cleanupErrors, []);
    assert.ok(report.backgroundErrors.every(error => !databaseFailure(error)), 'Runtime shutdown must precede database disposal.');
  });
  database = await createPostgresTestDatabase(t, 'collection_path');
  runtime = await createTestRuntime({ database, programDataPath, serverId: name,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryMonitorDelay: 0 },
    onError: error => report.backgroundErrors.push(errorObservation(error)) });
  assert.equal(runtime.plugins.get('local').enabled, true);
  const ancestors = path.join(work, 'empty-ignore-ancestors'); await fs.mkdir(ancestors, { recursive: true });
  const configuration = runtime.storage.configuration(), style = process.platform === 'win32' ? 'windows' : 'posix';
  configuration.instances.push({ id: 'collection-ignore-ancestors', type: 'local', config: { root: ancestors, writable: false } });
  configuration.mounts.push({ path: '/collection-ignore-ancestors', instanceId: 'collection-ignore-ancestors', capabilities: {} });
  configuration.ignorePrefixes = [{ identityRoot: path.parse(work).root, accessRoot: '/collection-ignore-ancestors',
    style, caseSensitive: style === 'posix', returnAccess: 'Explicit empty ignore ancestors for the isolated Collection fixture.' }];
  await runtime.storage.configure(configuration);
  assert.throws(() => runtime.storage.identityMap.resolve({ identityPath: path.join(path.parse(work).root, '.ignore'), style }),
    { code: 'not-found' }, 'The ancestor declaration must not grant general file access outside the instance.');
  return { runtime, database, report, programDataPath, heldOwners };
}

test('Collection HTTP members, metadata children and monitor lookup resolve persisted state paths through current runtime roots', pg, async t => {
  const { runtime, database, report, programDataPath, heldOwners } = await fixture(t, 'collection-path-resolution');
  const dataPath = runtime.library.options.dataPath, metadataPath = runtime.library.options.metadataPath;
  const locations = [path.join(dataPath, 'members', 'Data member'), path.join(metadataPath, 'members', 'Metadata member'),
    path.join(programDataPath, 'Plain member'), path.join(dataPath, 'members', 'Added member')];
  const members = locations.map((Path, index) => {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
    Object.assign(item, { Id: `ce200000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      Name: path.basename(Path), Path, DateCreated: '2026-01-02T03:04:05.0000000Z' });
    return item;
  });
  for (const location of locations) await runtime.fileSystem.mkdir(location, { recursive: true });
  await runtime.itemCreation.createItems(members);
  const expectedPaths = [path.join('%AppDataPath%', 'members', 'Data member'), path.join('%MetadataPath%', 'members', 'Metadata member'),
    locations[2], path.join('%AppDataPath%', 'members', 'Added member')];
  for (const [index, item] of members.entries()) {
    assert.equal((await database.rows('BaseItems', { where: { Id: item.Id } }))[0].Path, expectedPaths[index]);
  }
  const apiKey = await runtime.apiKeys.create('Collection path resolution');
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const request = async (suffix, { method = 'POST', body } = {}) => {
    const response = await fetch(origin + suffix, { method,
      headers: { Authorization: `MediaBrowser Token="${apiKey.AccessToken}"`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* Preserve the actual HTTP failure body for the assertion. */ }
    return { status: response.status, text, body: parsed };
  };
  const created = await request('/Collections?name=Path%20only%20members');
  assert.equal(created.status, 200, created.text); await runtime.metadata.drain();
  let collection, collectionLease, nextLease = 0;
  report.collectionOwnership = [];
  // The fixture publishes unresolved links across several separate consumers.
  // Hold the current cache entity through each import/consumer interval. A
  // completed real refresh may register a replacement before the next import.
  const holdCurrentCollection = async () => {
    const current = await runtime.itemCreation.getItemById(created.body.Id);
    if (current === collection) return;
    const lease = { number: ++nextLease, owners: 0 };
    lease.observer = observeNativeItemLinkOwnership(current, event => {
      lease.owners = event.count; report.collectionOwnership.push({ lease: lease.number, phase: event.phase, count: event.count });
    });
    try { lease.owner = runtime.itemCreation.retainItem(current); }
    catch (error) { lease.observer.release(); throw error; }
    heldOwners.add(lease.owner); heldOwners.add(lease.observer);
    const previous = collectionLease;
    collection = current; collectionLease = lease;
    if (previous) {
      previous.owner.release(); heldOwners.delete(previous.owner);
      await runtime.collections.linkedChildren.flushReleases();
      previous.observer.release(); heldOwners.delete(previous.observer);
      report.observations.push({ phase: 'collection-lease-transfer', from: previous.number, to: lease.number, previousOwners: previous.owners });
    }
  };
  await holdCurrentCollection();
  const importPaths = async paths => {
    await holdCurrentCollection();
    const xml = '<Item><CollectionItems>' + paths.map(value => `<CollectionItem><Path>${xmlText(value)}</Path></CollectionItem>`).join('') + '</CollectionItems></Item>';
    const filename = path.join(collection.Path, 'collection.xml');
    const observation = { phase: 'xml-import', paths, metadataPath: runtime.library.options.metadataPath,
      lease: collectionLease.number, cachedExactItem: runtime.itemCreation.getCachedItemById(collection.Id) === collection,
      ownersBefore: collectionLease.owners };
    report.observations.push(observation); assert.ok(collectionLease.owners > 0); assert.equal(observation.cachedExactItem, true);
    await runtime.fileSystem.writeFile(filename, xml);
    const written = await runtime.fileSystem.readFile(filename);
    observation.writtenXml = written.toString('utf8'); assert.deepEqual(written, Buffer.from(xml));
    await runtime.metadata.loadContext.withContext(collection.Id, { draft: collection }, async loaded => {
      const provider = runtime.metadata.registry.discover({ item: collection, kind: 'local', includeDisabled: true })
        .find(provider => provider.id === 'BoxSetXmlProvider');
      assert.ok(provider);
      const parsed = await provider.getMetadata(collection, loaded.context);
      try {
        assert.equal(parsed.HasMetadata, true);
        observation.providerPaths = (await runtime.collections.linkedChildren.page(parsed.Item.LinkedChildren)).map(row => row.Path);
        assert.deepEqual(observation.providerPaths, paths);
        publishNativeItemLinks(collection, retainNativeItemLinks(parsed.Item));
        observation.pathsBeforeContextRelease = (await runtime.collections.linkedChildren.page(collection.LinkedChildren)).map(row => row.Path);
        assert.deepEqual(observation.pathsBeforeContextRelease, paths);
      } finally { releaseNativeItemLinks(parsed.Item); await runtime.collections.linkedChildren.flushReleases(); }
    });
    const raw = await runtime.collections.linkedChildren.page(collection.LinkedChildren);
    observation.pathsAfterContextRelease = raw.map(row => row.Path); observation.ownersAfter = collectionLease.owners;
    assert.ok(collectionLease.owners > 0); assert.deepEqual(await runtime.fileSystem.readFile(filename), written);
    assert.deepEqual(raw.map(row => row.Path), paths); assert.ok(raw.every(row => row.ItemId === null));
  };
  const metadataChildren = () => runtime.metadata.loadContext.withContext(collection.Id, { draft: collection }, async loaded => {
    const sequence = await loaded.metadataChildren(collection), ids = [];
    try { for await (const page of sequence.pages()) ids.push(...page.map(item => idKey(item.Id))); }
    finally { await sequence.close(); }
    return ids;
  });
  // Actual Local XML creates the unresolved PostgreSQL relation. Metadata and
  // the HTTP mutation each receive a fresh path-only relation, not an ID cache.
  await importPaths(locations.slice(0, 3));
  assert.deepEqual(await metadataChildren(), members.slice(0, 3).map(item => idKey(item.Id)));
  await importPaths(locations.slice(0, 3));
  const added = await request(`/Collections/${collection.Id}/Items?ids=${members[3].Id}`);
  assert.equal(added.status, 204, added.text); await runtime.metadata.drain();
  const persistedIds = async () => (await database.rows('LinkedChildren', { where: { ParentId: collection.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId));
  assert.deepEqual(await persistedIds(), members.map(item => idKey(item.Id)));
  const savedXml = await runtime.fileSystem.readFile(path.join(collection.Path, 'collection.xml'), 'utf8');
  for (const location of locations) assert.ok(savedXml.includes(xmlText(location)));

  const affected = await runtime.libraryMonitorHost.resolveAffectedItem(path.join(locations[0], 'external.nfo'));
  assert.ok(affected);
  try { assert.equal(idKey(affected.item.Id), idKey(members[0].Id)); }
  finally { await affected.dispose(); }
  const admitted = Promise.withResolvers(), changed = runtime.libraryMonitorHost.changedExternally.bind(runtime.libraryMonitorHost);
  const queue = runtime.metadata.queue.bind(runtime.metadata); let monitoredRefresh;
  runtime.metadata.queue = (reference, ...args) => {
    const operation = queue(reference, ...args);
    if (idKey(reference) === idKey(members[0].Id)) monitoredRefresh = outcome(operation);
    return operation;
  };
  runtime.libraryMonitorHost.changedExternally = item => {
    const value = changed(item); if (idKey(item.Id) === idKey(members[0].Id)) admitted.resolve(); return value;
  };
  const sidecar = path.join(locations[0], 'external.nfo');
  await runtime.fileSystem.writeFile(sidecar, '<item><title>External change</title></item>');
  await runtime.libraryMonitor.reportFileSystemChanged(sidecar);
  await deadline(admitted.promise, 'The real monitor did not resolve the tokenized state path and admit its refresh.');
  assert.ok(monitoredRefresh); assert.equal(Object.hasOwn(await monitoredRefresh, 'error'), false);
  await runtime.metadata.drain();

  // Save a real server configuration and keep the same persisted token. The
  // reverse-path function must observe the live metadata root getter.
  const nextMetadataPath = path.join(programDataPath, 'metadata-next'), nextMemberPath = path.join(nextMetadataPath, 'members', 'Metadata member');
  await runtime.fileSystem.mkdir(nextMemberPath, { recursive: true });
  const configuration = await request('/System/Configuration', { method: 'GET' }); assert.equal(configuration.status, 200);
  const configured = await request('/System/Configuration', { body: { ...configuration.body, MetadataPath: nextMetadataPath } });
  assert.equal(configured.status, 204); assert.equal(runtime.library.options.metadataPath, nextMetadataPath);
  runtime.itemCreation.unregisterItem(members[1].Id);
  assert.equal(runtime.library.options.reversePath(nextMemberPath), expectedPaths[1]);
  assert.equal(runtime.library.options.reversePath(locations[1]), locations[1]);
  assert.equal(runtime.library.options.reversePath(locations[2]), locations[2]);
  await importPaths([nextMemberPath]);
  assert.deepEqual(await metadataChildren(), [idKey(members[1].Id)]);
  await importPaths([nextMemberPath]);
  assert.equal((await request(`/Collections/${collection.Id}/Items?ids=${members[0].Id}`)).status, 204);
  await runtime.metadata.drain();
  assert.deepEqual(await persistedIds(), [members[1], members[0]].map(item => idKey(item.Id)));
  assert.equal((await database.rows('BaseItems', { where: { Id: members[1].Id } }))[0].Path, expectedPaths[1]);
  const moved = await runtime.libraryMonitorHost.resolveAffectedItem(path.join(nextMemberPath, 'later.nfo'));
  assert.ok(moved);
  try { assert.equal(idKey(moved.item.Id), idKey(members[1].Id)); assert.equal(moved.item.Path, nextMemberPath); }
  finally { await moved.dispose(); }
  report.observations.push({ persistedMemberPaths: expectedPaths, collectionPath: collection.Path,
    httpMemberIds: await persistedIds(), monitorAdmission: members[0].Id, configuredMetadataPath: nextMetadataPath });
  const ownersBeforeRelease = collectionLease.owners;
  collectionLease.owner.release(); heldOwners.delete(collectionLease.owner);
  assert.equal(collectionLease.owners, ownersBeforeRelease - 1);
  await runtime.collections.linkedChildren.flushReleases();
  collectionLease.observer.release(); heldOwners.delete(collectionLease.observer);
  report.collectionLease = { leases: nextLease, ownersBeforeRelease, ownersAfterRelease: collectionLease.owners, flushed: true };
});

test('Collection state path failures preserve real Local operation reasons and release the retained generation', pg, async t => {
  const { runtime, database, report, programDataPath } = await fixture(t, 'collection-path-failures');
  const parent = await runtime.collections.getCollectionsFolder(true);
  await runtime.metadata.drain();
  const retain = runtime.fileSystem.retainDirectories, complete = runtime.collections.monitor.reportFileSystemChangeComplete.bind(runtime.collections.monitor);
  const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined], ['aggregate'], ['diagnostic-getter']];
  let selected;
  runtime.collections.monitor.reportFileSystemChangeComplete = async (...args) => {
    await complete(...args); if (selected && args[0] === selected.filename) selected.completions++;
  };
  runtime.fileSystem.retainDirectories = (...args) => {
    const owner = retain(...args), current = selected;
    if (!current || !args[0].includes(parent.Path)) return owner;
    const files = new Proxy(owner.fileSystem, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'mkdir') return async (...args) => {
        await value.apply(target, args); if (args[0] === current.filename) current.created = true;
      };
      if (key === 'realpath' || key === 'lstat') return async (...args) => {
        let result, failed = false, failure;
        try { result = await value.apply(target, args); }
        catch (error) { failed = true; failure = error; }
        const inject = !current.injected && (current.phase === 'root' && key === 'realpath' && args[0] === programDataPath
          || current.phase === 'created-target' && current.created && key === 'realpath' && args[0] === current.filename
          || current.phase === 'missing-lstat' && key === 'lstat' && args[0] === current.filename);
        if (inject) {
          if (current.phase === 'missing-lstat') { assert.equal(failed, true); assert.equal(failure.code, 'ENOENT'); }
          current.injected = true;
          if (current.label === 'aggregate') current.failure = Object.assign(new AggregateError([current.missing, false],
            'The missing-path operation also failed cleanup.', { cause: current.missing }), { code: 'ENOENT' });
          else if (current.label === 'diagnostic-getter') {
            current.failure = new Error('The original Local continuation failed.');
            Object.defineProperty(current.failure, 'code', { get() { throw new Error('A diagnostic getter must not replace the original reason.'); } });
          }
          throw current.failure;
        }
        if (failed) throw failure;
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { fileSystem: files, async close() { await owner.close(); current.closed++; throw 0; } };
  };
  t.after(() => { selected = undefined; });
  for (const phase of ['root', 'created-target', 'missing-lstat']) for (const [label, failure] of reasons) await t.test(`${phase}/${label}`, async () => {
    const name = `${phase}-${label}`, filename = path.join(parent.Path, name + ' [boxset]');
    const missing = await outcome(runtime.fileSystem.stat(filename));
    assert.equal(missing.error.code, 'ENOENT');
    const current = selected = { phase, label, failure, missing: missing.error, filename, injected: false, created: false, closed: 0, completions: 0 };
    const result = await outcome(runtime.collections.create({ Name: name, ItemIdList: [] }));
    selected = undefined;
    assert.equal(current.injected, true); assert.equal(current.closed, 1);
    assert.ok(result.error instanceof AggregateError); assert.equal(result.error.cause, current.failure);
    assert.deepEqual(result.error.errors, [current.failure, 0]);
    assert.equal(current.completions, phase === 'created-target' ? 1 : 0);
    assert.deepEqual(await database.rows('BaseItems', { where: { Name: name } }), []);
    if (phase === 'created-target') assert.equal((await fs.stat(filename)).isDirectory(), true);
    else await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
    report.observations.push({ phase, label, retainedStorageClosed: current.closed, directoryPrefixPreserved: current.created,
      primaryIdentityPreserved: result.error.cause === current.failure, monitorCompletions: current.completions });
  });
  const recovered = await runtime.collections.create({ Name: 'Recovered path checks', ItemIdList: [] });
  await runtime.metadata.drain();
  assert.equal((await database.rows('BaseItems', { where: { Id: recovered.Id } })).length, 1);
  assert.equal((await fs.stat(recovered.Path)).isDirectory(), true);
});
