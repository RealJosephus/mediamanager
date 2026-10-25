import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MetadataSaveHost, MetadataRegistry } from '../../src/metadata/index.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

test('metadata saver host loads authoritative context and writes NFO from subscribed user events', async (t) => {
  const storage = new StorageRegistry(); storage.registerType('fixture', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/network', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const registry = new MetadataRegistry();
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-save-host-'));
  registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs, spoolRoot, getConfiguration: () => ({ ...defaultNfoConfiguration(), UserId: '10000000-0000-0000-0000-000000000001' }) }));
  const item = { Id: 'fixture', Type: 'Video', Path: 'D:\\identity\\video.mkv', Name: 'Authoritative name', IsFileProtocol: true, SupportsLocalMetadata: true,
    RunTimeTicks: 6000000000n, DateCreated: '2026-01-01T00:00:00Z' };
  let playCount = 1; let loads = 0; const errors = []; const events = new EventEmitter();
  const host = new MetadataSaveHost({ registry, logger: { error: (error) => errors.push(error) }, now: () => '2026-09-26T00:00:00Z',
    loadContext: async (reference) => {
      assert.equal(reference.Id, item.Id); loads++;
      return { item, libraryOptions: { MetadataSavers: ['Nfo'] }, exists: async () => false,
        context: { accessPath: '/network/video.mkv', people: [{ Name: 'Current actor', Type: 'Actor' }], images: [], mediaStreams: [], tracks: [], albums: [],
          userData: { Played: true, IsFavorite: true, PlayCount: playCount, PlaybackPositionTicks: 0n } } };
    } });
  t.after(async () => { await host.dispose(); await storage.close(); await rm(spoolRoot, { recursive: true, force: true }); });
  host.start(events); host.start(events);
  assert.equal(events.listenerCount('UserDataSaved'), 1);
  events.emit('UserDataSaved', { Item: { Id: item.Id }, SaveReason: 'PlaybackProgress' });
  await host.drain(); assert.equal(loads, 0);
  events.emit('UserDataSaved', { Item: { Id: item.Id, Name: 'Stale event name' }, SaveReason: 'TogglePlayed', UserId: 'other-user' });
  await host.drain(); assert.equal(loads, 1); assert.deepEqual(errors, []);
  assert.equal(item.DateLastSaved, '2026-09-26T00:00:00Z');
  let result = await registry.plugins()[0].getMetadata(item, { accessPath: '/network/video.mkv' });
  assert.equal(result.Item.Name, 'Authoritative name'); assert.equal(result.People[0].Name, 'Current actor');
  const read = async () => { const handle = await vfs.openRead('/network/video.nfo'); try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); } finally { await handle.close(); } };
  assert.match(await read(), /<playcount>1<\/playcount>/);
  playCount = 2; events.emit('UserDataSaved', { Item: { Id: item.Id }, SaveReason: 'PlaybackFinished' }); await host.drain();
  assert.match(await read(), /<playcount>2<\/playcount>/);
  host.stop(); assert.equal(events.listenerCount('UserDataSaved'), 0);
  events.emit('UserDataSaved', { Item: { Id: item.Id }, SaveReason: 'TogglePlayed' }); await host.drain(); assert.equal(loads, 2);
});

test('metadata saver host rejects invalid contexts, excludes disabled plugins, and drains active writes', async t => {
  const registry = new MetadataRegistry(); const events = new EventEmitter(); const errors = [];
  let loads = 0, callbacks = 0;
  const plugin = registry.register({ id: 'fixture', name: 'Fixture', providers: [], onUserDataSaved: async (_event, save) => {
    callbacks++; return save({}, 'MetadataDownload');
  } });
  const host = new MetadataSaveHost({ registry, loadContext: async () => { loads++; return {}; }, logger: { error: (error) => errors.push(error) } });
  host.start(events); events.emit('UserDataSaved', { Item: {}, SaveReason: 'TogglePlayed' }); await host.drain();
  assert.equal(loads, 1); assert.equal(callbacks, 0);
  for (const error of errors) assert.match(error.message, /context loader/u);
  t.diagnostic(JSON.stringify({ contextFailureDiagnostics: errors.map(error => ({ name: error.name,
    code: error.code, message: error.message, stack: error.stack })) }));
  const diagnosticPrefix = errors.length;
  plugin.enabled = false; events.emit('UserDataSaved', { Item: {}, SaveReason: 'TogglePlayed' }); await host.drain();
  assert.equal(loads, 1); assert.equal(callbacks, 0); assert.deepEqual(errors.slice(diagnosticPrefix), []);
  let complete; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  plugin.enabled = true; plugin.onUserDataSaved = async () => { started(); await new Promise((resolve) => { complete = resolve; }); };
  host.loadContext = async () => ({ item: {}, context: {}, libraryOptions: {}, exists: async () => false });
  events.emit('UserDataSaved', { Item: {}, SaveReason: 'TogglePlayed' }); await ready;
  let disposed = false; const disposal = host.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false); assert.equal(events.listenerCount('UserDataSaved'), 0);
  complete(); await disposal; assert.equal(disposed, true); assert.deepEqual(errors.slice(diagnosticPrefix), []);
});

test('manual metadata saving drains its active saver and releases the authoritative context', async () => {
  let unblock, entered, disposed = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const registry = new MetadataRegistry();
  registry.register({ id: 'owned', name: 'Owned', providers: [{ id: 'owned-saver', name: 'Owned', kind: 'saver', itemTypes: ['BoxSet'],
    isEnabledFor: () => true, save: async () => { entered(); await new Promise(resolve => { unblock = resolve; }); } }] });
  const host = new MetadataSaveHost({ registry, loadContext: async () => ({ item: { Type: 'BoxSet', IsFileProtocol: true },
    context: {}, libraryOptions: { MetadataSavers: ['Owned'] }, exists: async () => false, dispose: async () => { disposed++; } }) });
  const saving = host.save({}, 'MetadataEdit'); await ready;
  let drained = false; const closing = host.dispose().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.equal(disposed, 0);
  unblock(); await saving; await closing; assert.equal(disposed, 1);
});

test('subscribed metadata plugin failure releases its loaded relation owner before logging', async () => {
  const registry = new MetadataRegistry(), source = new EventEmitter(), calls = [];
  registry.register({ id: 'failure', name: 'Failure', providers: [], onUserDataSaved: async () => { throw new Error('controlled plugin failure'); } });
  const host = new MetadataSaveHost({ registry, loadContext: async () => ({ item: {}, context: {}, libraryOptions: {}, exists: async () => false,
    dispose: async () => calls.push('dispose') }), logger: { error: () => calls.push('logger') } });
  host.start(source); source.emit('UserDataSaved', { Item: {} }); await host.drain(); await host.dispose();
  assert.deepEqual(calls, ['dispose', 'logger']);
});
