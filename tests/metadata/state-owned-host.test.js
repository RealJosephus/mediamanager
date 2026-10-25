import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupStateOwned, ownerId } from './state-owned-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { idKey, dateText } from '../../src/library/records.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const root = new URL('./fixtures/state-owned-extras/', import.meta.url);
const input = parseLosslessJson(await readFile(new URL('input.json', root), 'utf8'));
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const noMetadata = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' };
const assertOwnedErrors = (t, errors, allowed) => {
  t.diagnostic(JSON.stringify({ ownedErrorDiagnostics: errors.map(({ error, stage }) => ({
    stage, code: error?.code, message: error?.message, stack: error?.stack ?? String(error) })) }));
  assert.deepEqual(errors.filter(({ error }) => !allowed(error)), []);
};
const assertOwnerSaved = async fixture => {
  const [owner] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
  // refresh(id) reloads the recorded SQL owner; the controlled in-memory edits
  // used by the narrower lifecycle recording are not this host's input.
  assert.equal(owner.Name, 'Stored owner'); assert.equal(owner.Genres ?? '', ''); assert.equal(owner.Overview, null);
  assert.equal(dateText(owner.DateLastSaved), fixture.now);
  assert.equal(dateText(parseLosslessJson(owner.Data).DateLastSaved), fixture.now);
};
const observeSqlFailures = fixture => {
  const failures = [], client = fixture.database.client;
  const query = (fixture.database.queryHook ?? client.query).bind(client);
  fixture.database.client.query = async (...args) => {
    try { return await query(...args); }
    catch (error) { failures.push({ code: error.code, message: error.message, stack: error.stack }); throw error; }
  };
  return failures;
};
const setup = async (t, type, name, options) => {
  const sample = input.find(value => value.name === type + '-' + name);
  const value = await setupStateOwned(t, sample, native.results.find(value => value.name === sample.name), options);
  const errors = [], events = [];
  value.fixture.host.logger = { error: (error, stage) => errors.push({ error, stage }) };
  for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) value.fixture.host.updates.on(name,
    event => events.push({ name, id: idKey(event.Item.Id) }));
  return { ...value, errors, events };
};
for (const type of ['playlist', 'boxset']) {
  test('postgres: state host ' + type + ' saves new media through its explicit item binding', async t => {
    const { fixture, loaded, errors, events } = await setup(t, type, 'new-trailer');
    await fixture.host.refresh(ownerId, noMetadata);
    const [extra] = (await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null);
    assert.ok(extra); assert.equal(extra.ExtraType, 2); assert.equal(idKey(extra.OwnerId), idKey(ownerId));
    assert.equal(extra.ParentId, null); assert.equal(extra.TopParentId, null); assert.equal(extra.Name, 'Trailer');
    assert.equal(parseLosslessJson(extra.Data).Size, Buffer.byteLength('network media control'),
      'The first provider save reads bound network metadata, not the different host media file.');
    assert.equal((await readFile(path.join(loaded.item.Path, 'trailer.mkv'))).length, 16);
    assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === idKey(extra.Id)));
    assert.equal(events.some(event => event.name === 'ItemAdded'), false); assert.deepEqual(errors, []);
  });

  test('postgres: state host ' + type + ' does not read an unmapped extra from host media', async t => {
    const { fixture, loaded, errors, events } = await setup(t, type, 'new-trailer', { bindMedia: false });
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual((await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null), []);
    assertOwnedErrors(t, errors, error => error.code === 'not-found');
    await assertOwnerSaved(fixture);
    assert.equal((await readFile(path.join(loaded.item.Path, 'trailer.mkv'))).length, 16);
    assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === idKey(ownerId)));
    assert.equal(events.some(event => event.id !== idKey(ownerId)), false);
  });

  test('postgres: state host ' + type + ' rejects unknown external ignore ancestors', async t => {
    const { fixture, loaded, oldId, errors, events } = await setup(t, type, 'missing-trailer', { ancestors: false });
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    const marker = path.join(internalImagePath(old, loaded.metadataPath), 'marker.txt');
    const before = await fixture.database.rows('BaseItems', { where: { Id: oldId } });
    await assert.rejects(fixture.ignoreRule.shouldIgnore(path.join(loaded.item.Path, 'trailer.mkv')),
      { code: 'ignore-search-unmapped', status: 501 });
    await fixture.host.refresh(ownerId, noMetadata);
    assertOwnedErrors(t, errors, error => error.code === 'ignore-search-unmapped' && error.status === 501);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: oldId } }), before);
    assert.equal(await readFile(marker, 'utf8'), 'owned marker');
    assert.equal(events.some(event => event.name === 'ItemRemoved'), false);
    await assertOwnerSaved(fixture);
    assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === idKey(ownerId)));
  });

  for (const cancelled of [false, true]) test('postgres: state host ' + type + ' missing deletion ' + (cancelled ? 'precedes cancellation' : 'keeps remote source'), async t => {
    const { fixture, loaded, oldId, errors, events } = await setup(t, type, 'missing-trailer');
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    const marker = path.join(internalImagePath(old, loaded.metadataPath), 'marker.txt');
    const reason = Object.assign(new Error('Controlled state-owned cancellation'), { code: 'controlled-state-owned-cancellation' });
    const signal = AbortSignal.abort(reason);
    if (cancelled) await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal }),
      { message: reason.message, code: reason.code });
    else await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: oldId } }), []);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal((await fixture.vfs.stat('/state-owned-media/bound/0')).kind, 'file');
    assert.ok(events.some(event => event.name === 'ItemRemoved' && event.id === idKey(oldId)));
    if (cancelled) {
      assert.equal(signal.aborted, true);
      assertOwnedErrors(t, errors, error => error.code === reason.code || error.code === 'cancelled');
    } else assert.deepEqual(errors, []);
  });

  test('postgres: state host ' + type + ' already-cancelled new member creates no row', async t => {
    const { fixture, errors, events } = await setup(t, type, 'new-trailer');
    const reason = Object.assign(new Error('Controlled state-owned cancellation'), { code: 'controlled-state-owned-cancellation' });
    const signal = AbortSignal.abort(reason);
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal }), { message: reason.message, code: reason.code });
    assert.equal(signal.aborted, true);
    assertOwnedErrors(t, errors, error => error.code === reason.code || error.code === 'cancelled');
    assert.deepEqual((await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null), []);
    assert.deepEqual(events, []);
  });

  test('postgres: state host ' + type + ' extra insert failure does not prevent owner save', async t => {
    const { fixture, loaded, errors, events } = await setup(t, type, 'new-trailer');
    await fixture.database.client.query("CREATE FUNCTION state_owned_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.\"ExtraType\" IS NOT NULL THEN RAISE EXCEPTION 'Controlled state-owned insert failure'; END IF; RETURN NEW; END $$");
    await fixture.database.client.query('CREATE TRIGGER state_owned_failure BEFORE INSERT ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION state_owned_failure()');
    const sqlFailures = observeSqlFailures(fixture);
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual((await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null), []);
    assert.ok(sqlFailures.some(error => error.code === 'P0001' && error.message === 'Controlled state-owned insert failure'));
    t.diagnostic(JSON.stringify({ sqlFailureDiagnostics: sqlFailures }));
    assertOwnedErrors(t, errors, error => error.code === 'P0001' && error.message === 'Controlled state-owned insert failure');
    await assertOwnerSaved(fixture);
    assert.equal((await readFile(path.join(loaded.item.Path, 'trailer.mkv'))).length, 16);
    assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === idKey(ownerId)));
    assert.equal(events.some(event => event.id !== idKey(ownerId)), false);
  });

  test('postgres: state host ' + type + ' preview cannot cache absence before a state ignore appears', async t => {
    const { fixture, loaded, errors } = await setup(t, type, 'new-trailer');
    let validates = 0, saves = 0;
    fixture.registry.register({ id: 'state-preflight', name: 'State preflight', providers: [{
      id: 'writer', name: 'Controlled state ignore writer', kind: 'saver', itemTypes: ['Trailer'], isEnabledFor: () => true,
      async validateSave() { validates++; await writeFile(path.join(loaded.item.Path, '.ignore'), '*.mkv'); },
      save() { saves++; return []; }
    }] });
    const original = fixture.host.loadContext;
    const configured = Object.assign(async (...args) => {
      const loaded = await original(...args);
      loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Controlled state ignore writer'] };
      loaded.loadDraftContext = item => configured(item.Id, { draft: item });
      return loaded;
    }, original);
    fixture.host.loadContext = configured;
    await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(validates, 1); assert.equal(saves, 0);
    assert.deepEqual((await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null), []); assert.deepEqual(errors, []);
  });

  for (const change of ['owner', 'competing-row', 'missing-intent', 'missing-owner-frame']) test(
    'postgres: state host ' + type + ' validates ' + change + ' before new extra invalidation', async t => {
      const { fixture, loaded } = await setup(t, type, 'new-trailer');
      const found = await loaded.findOwnedExtras(await loaded.loadLibraryState()), extra = found.extras[0];
      extra.item.OwnerId = extra.ownerId; extra.item.ParentId = '00000000-0000-0000-0000-000000000000';
      const context = await loaded.loadDraftContext(extra.item);
      context.creationIntent = 'owned-extra';
      context.ownedExtraOwner = { Id: ownerId, snapshot: loaded.snapshot, versionLinks: loaded.versionLinks };
      const directory = fixture.host.externalData.paths(extra.item, context)[0], marker = path.join(directory, 'guarded-cache');
      await mkdir(directory, { recursive: true }); await writeFile(marker, 'preserve before validation');
      const before = await fixture.database.rows('BaseItems');
      if (change === 'owner') await fixture.database.update('BaseItems', { Id: ownerId }, { Name: 'Competing owner' });
      if (change === 'competing-row') await fixture.database.insert('BaseItems', {
        ...before.find(row => idKey(row.Id) === idKey(ownerId)),
        Id: extra.item.Id, Type: extra.item.NativeType, Name: 'Competing extra', Path: extra.item.Path,
        ParentId: null, OwnerId: ownerId, ExtraType: 2, Data: '{}'
      });
      if (change === 'missing-intent') delete context.creationIntent;
      if (change === 'missing-owner-frame') delete context.ownedExtraOwner;
      const expected = await fixture.database.rows('BaseItems');
      await assert.rejects(fixture.host.externalData.invalidateChangedVideo(extra.item, '2026-10-10T00:00:00.0000000Z',
        { expectedSnapshot: undefined, loaded: context }), { code: change === 'owner' ? 'metadata-conflict' : 'version-changed' });
      assert.equal(await readFile(marker, 'utf8'), 'preserve before validation');
      assert.deepEqual(await fixture.database.rows('BaseItems'), expected);
    });

  test('postgres: state host ' + type + ' cleanup SQL failure retains native prefix but prevents first insert', async t => {
    const { fixture, loaded, errors, events } = await setup(t, type, 'new-trailer');
    await fixture.adapter.write('/bound/0', Buffer.from('network media control'), { modified: '2026-10-10T00:00:00.0000000Z' });
    const { extras: [extra] } = await loaded.findOwnedExtras(await loaded.loadLibraryState());
    const directory = fixture.host.externalData.paths(extra.item, extra.context)[0], marker = path.join(directory, 'prefix-cache');
    await mkdir(directory, { recursive: true }); await writeFile(marker, 'removed before SQL failure');
    await fixture.database.client.query("CREATE FUNCTION state_owned_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled state-owned cleanup failure'; END $$");
    await fixture.database.client.query('CREATE TRIGGER state_owned_cleanup_failure BEFORE DELETE ON "KeyframeData" FOR EACH STATEMENT EXECUTE FUNCTION state_owned_cleanup_failure()');
    const sqlFailures = observeSqlFailures(fixture);
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual((await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null), []);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal((await fixture.vfs.stat('/state-owned-media/bound/0')).kind, 'file');
    assert.ok(sqlFailures.some(error => error.code === 'P0001' && error.message === 'Controlled state-owned cleanup failure'));
    t.diagnostic(JSON.stringify({ sqlFailureDiagnostics: sqlFailures }));
    assertOwnedErrors(t, errors, error => error.code === 'P0001' && error.message === 'Controlled state-owned cleanup failure');
    await assertOwnerSaved(fixture);
    assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === idKey(ownerId)));
    assert.equal(events.some(event => event.id !== idKey(ownerId)), false);
  });
}


test('postgres: state owned extras use actual WebDAV for save and retain the source after missing cleanup', async t => {
  const service = await startActualWebDav({ evidenceDirectory: process.env.MEDIAMANAGER_STATE_OWNED_WEBDAV_EVIDENCE });
  t.after(() => service.stop());
  for (const type of ['playlist', 'boxset']) await t.test(type, async t => {
    const { fixture, loaded, errors } = await setup(t, type, 'new-trailer');
    fixture.storage.registerType('webdav', options => new WebDavAdapter(options, { resolveCredential: async () => service.authorization }));
    await fixture.storage.createInstance('actual-state-owned', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'isolated-state-owned',
      capabilities: { create: true, replace: true } });
    fixture.vfs.mount({ path: '/state-owned-network', instanceId: 'actual-state-owned',
      capabilities: { create: true, replace: true } });
    const filename = path.join(loaded.item.Path, 'trailer.mkv'), remotePath = '/state-owned-network/' + type + '-trailer.mkv';
    const extraId = loaded.getNewItemId(filename, 'MediaBrowser.Controller.Entities.Trailer');
    fixture.identityMap.bind(extraId, remotePath);
    const bytes = Buffer.from('actual network media control');
    await fixture.vfs.write(remotePath, bytes);
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(errors, []);
    const [extra] = (await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null);
    assert.ok(extra); assert.equal(idKey(extra.Id), idKey(extraId));
    assert.equal(parseLosslessJson(extra.Data).Size, bytes.length);
    await unlink(filename);
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: extra.Id } }), []);
    const handle = await fixture.vfs.openRead(remotePath), parts = [];
    try { for await (const part of handle.stream) parts.push(Buffer.from(part)); } finally { await handle.close(); }
    assert.deepEqual(Buffer.concat(parts), bytes);
    assert.deepEqual(errors, []);
  });
});
