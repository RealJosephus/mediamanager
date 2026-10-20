import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../src/runtime.js';
import { nativeItemDescriptor, nativeItemTypes } from '../../src/library/native-item-entity.js';
import { idKey, dateTicks } from '../../src/library/records.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('../metadata/fixtures/internal-edit/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const ids = Object.fromEntries(input.nodes.map((node, index) => [node.key, `87000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
ids.missing = '87000000-0000-0000-0000-999999999999';
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const relationships = ['AncestorIds', 'LinkedChildren', 'BaseItemProviders', 'BaseItemMetadataFields', 'PeopleBaseItemMap', 'BaseItemImageInfos'];
const descriptors = new Map(nativeItemTypes.map(value => { const descriptor = nativeItemDescriptor(value); return [descriptor.type, descriptor]; }));
let recording;
function nativeRun() {
  return recording ??= (async () => {
    const output = path.join(validationOutputRoot(), 'internal-edit-' + randomUUID());
    await mkdir(output);
    const evidence = await recordOracle({ project: 'tests/metadata/fixtures/internal-edit/Oracle.csproj', output: path.join(output, 'native'),
      args: [fileURLToPath(inputFile), '{output}/native.json'] });
    const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
    assert.equal(evidence.passed, true); assert.equal(native.actualExecution, true);
    assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
    assert.deepEqual(native.results.map(value => value.type), input.types);
    return { native, output };
  })();
}

async function setup(type) {
  const database = await createPostgresTestDatabase(null, 'internal_edit');
  const root = await mkdtemp(path.join(os.tmpdir(), 'internal-edit-'));
  const programDataPath = path.join(root, 'data'), configurationDirectoryPath = path.join(root, 'config');
  const storage = new StorageRegistry();
  let runtime;
  async function close() {
    try { await runtime?.close(); }
    finally {
      try { await storage.close(); }
      finally { try { await dropPostgresTestDatabase(database); } finally { await rm(root, { recursive: true, force: true }); } }
    }
  }
  try {
    await mkdir(path.join(programDataPath, 'data'), { recursive: true }); await mkdir(configurationDirectoryPath);
    await writeFile(path.join(programDataPath, 'data/device.txt'), 'a'.repeat(32));
    await writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration/>');
    await writeFile(path.join(configurationDirectoryPath, 'network.xml'), '<NetworkConfiguration/>');
    storage.registerType('fixture', () => new MemoryStorageAdapter());
    await storage.createInstance('fixture', 'fixture', {});
    const vfs = new VirtualFileSystem(storage), identityMap = new IdentityAccessMap();
    runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath, vfs, identityMap,
      configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true, ContentTypes: [] },
      serverId: 'internal-edit-test' });
    for (const node of input.nodes) {
      const descriptor = descriptors.get(node.type === '$subject' ? type : node.type);
      let parent = node.parent;
      if (parent === '$children' || parent === '$second') parent = type === 'CollectionFolder' ? parent === '$children' ? 'physical1' : 'physical2' : 'subject';
      const data = descriptor.type === 'CollectionFolder'
        ? { PhysicalFolderIds: (node.key === 'subject' ? input.subjectPhysical : node.physical).map(key => ids[key]) } : {};
      await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: ids[node.key], Type: descriptor.nativeType,
        Name: node.key, CleanName: node.key.toLowerCase(), SortName: node.key.toLowerCase(),
        IsFolder: descriptor.family === 'folder', ParentId: parent == null ? null : ids[parent],
        MediaType: descriptor.family === 'video' ? 'Video' : 'Unknown', DateCreated: '2020-01-01 00:00:00', Data: JSON.stringify(data) }));
    }
    for (const node of input.nodes) for (const [SortOrder, key] of (node.key === 'subject' ? input.subjectLinked : node.linked ?? []).entries()) {
      await database.insert('LinkedChildren', { ParentId: ids[node.key], SortOrder, ChildId: ids[key], ChildType: 0 });
    }
    const apiKey = await runtime.apiKeys.create('Internal metadata edit oracle');
    runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const post = async request => {
      const response = await fetch(`${origin}/Items/${ids.subject}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `MediaBrowser Client="InternalEdit", Device="Test", DeviceId="internal-edit", Version="1", Token="${apiKey.AccessToken}"` },
        body: JSON.stringify(request) });
      return { status: response.status, contentType: response.headers.get('content-type'), bodyText: await response.text() };
    };
    return { database, runtime, post, close };
  } catch (error) { await close(); throw error; }
}

function project(item) {
  return { id: item.Id, type: item.Type, Name: item.Name ?? null, ForcedSortName: item.ForcedSortName ?? null, Overview: item.Overview ?? null,
    IsLocked: item.IsLocked, Genres: item.Genres, Tags: item.Tags, ProviderIds: item.ProviderIds, LockedFields: item.LockedFields,
    dateCreated: item.DateCreated,
    PreferredMetadataLanguage: item.PreferredMetadataLanguage ?? null, OfficialRating: item.OfficialRating ?? null, CustomRating: item.CustomRating ?? null };
}

function storedEditContract(item) {
  // The native callback retains the request's array; the candidate is reloaded
  // from BaseItemMetadataFields, whose primary key has no ordering column.
  // Preserve exact field membership/multiplicity and all 100ns date precision.
  return { ...item, LockedFields: [...item.LockedFields].sort(), dateCreated: dateTicks(item.dateCreated).toString() };
}

for (const type of input.types) test(`postgres: native ${type} metadata editing and recursive lock commits`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const { native, output } = await nativeRun(), expected = native.results.find(value => value.type === type);
  const fixture = await setup(type), { database, runtime, post } = fixture;
  const events = [], stages = [];
  runtime.metadataUpdates.on('ItemUpdated', event => events.push({ id: event.Item.Id, locked: event.Item.IsLocked, reason: event.UpdateReason }));
  try {
    for (const [index, request] of input.requests.entries()) {
      const before = await database.rows('BaseItems'), beforeRelations = Object.fromEntries(await Promise.all(relationships.map(async table => [table, await database.rows(table)])));
      events.length = 0;
      const response = await post(request);
      const items = [];
      for (const node of input.nodes) await runtime.metadata.loadContext.withContext(ids[node.key], { includeChildren: false }, loaded => items.push(project(loaded.item)));
      const after = await database.rows('BaseItems');
      const afterRelations = Object.fromEntries(await Promise.all(relationships.map(async table => [table, await database.rows(table)])));
      stages.push({ response, events: structuredClone(events), items, before, after, beforeRelations, afterRelations });
      assert.equal(response.status, expected.stages[index].status, response.bodyText);
      assert.equal(response.bodyText, '');
      assert.deepEqual(events, expected.stages[index].saves);
      assert.deepEqual(items.map(storedEditContract), expected.stages[index].items.map(storedEditContract));
      const changed = new Set(events.map(event => idKey(event.id)));
      assert.equal(after.length, before.length);
      for (const previous of before) if (!changed.has(idKey(previous.Id))) assert.deepEqual(after.find(row => row.Id === previous.Id), previous);
      for (const table of relationships) {
        const unselected = rows => rows.filter(row => !changed.has(idKey(row.ItemId ?? row.ParentId ?? row.ParentItemId)));
        assert.deepEqual(unselected(afterRelations[table]), unselected(beforeRelations[table]), table);
      }
    }
    await writeFile(path.join(output, `${type}-comparison.json`), json({ passed: true, type, stages }), { flag: 'wx' });
  } finally {
    await writeFile(path.join(output, `${type}-candidate.json`), json({ type, stages }), { flag: 'wx' });
    await fixture.close();
  }
});
