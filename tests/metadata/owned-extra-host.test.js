import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { idKey, dateText } from '../../src/library/records.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { nativeGuid } from '../../src/users/native.js';
import { setup } from './owned-extra-fixture.js';

const ownerId = '98c00000-0000-0000-0000-000000000001';
const noMetadata = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' };
const common = { expectedType: 'Movie', resolverType: 'Video', parseName: true, mixed: false, files: ['primary-trailer.mkv'] };
const getExtra = async fixture => (await fixture.database.rows('BaseItems')).filter(row => row.ExtraType != null);
const assertOwnedErrors = (t, errors, allowed) => {
  t.diagnostic(JSON.stringify({ ownedErrorDiagnostics: errors.map(({ error, stage }) => ({
    stage, code: error?.code, message: error?.message, stack: error?.stack ?? String(error) })) }));
  assert.deepEqual(errors.filter(({ error }) => !allowed(error)), []);
};
const assertOwnerSaved = async fixture => {
  const [owner] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
  // The host reloads the seeded SQL row when called with its ID.
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
const assertions = fixture => {
  const errors = [], events = [];
  fixture.host.logger = { error: (error, stage) => errors.push({ error, stage }) };
  for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) fixture.host.updates.on(name, event => events.push({ name, event }));
  return { errors, events };
};

for (const dialect of ['postgres']) {
  const databaseTest = (name, run) => test(`${dialect}: extra host ${name}`, run);

  for (const existing of [false, true]) databaseTest(`unmapped ignore ancestors preserve ${existing ? 'an existing extra' : 'a new candidate'}`, async t => {
    const value = await setup(t, dialect, { ...common, ...(existing ? { existingType: true, missing: true } : {}) });
    const { fixture, loaded, oldId } = value;
    const original = await getExtra(fixture);
    const old = existing ? await loaded.videoVersionDiscovery.lookup(loaded, oldId) : null;
    const marker = old && path.join(internalImagePath(old, loaded.metadataPath), 'marker.txt');
    fixture.ignoreRule.identityMap = fixture.identityMap;
    fixture.ignoreRule.clearDirectoryCache();
    const { errors, events } = assertions(fixture);
    await assert.rejects(fixture.ignoreRule.shouldIgnore(path.join(fixture.stateRoot, 'media', 'primary-trailer.mkv')),
      { code: 'ignore-search-unmapped', status: 501 });
    await fixture.host.refresh(ownerId, noMetadata);
    assertOwnedErrors(t, errors, error => error.code === 'ignore-search-unmapped' && error.status === 501);
    assert.deepEqual(await getExtra(fixture), original);
    await assertOwnerSaved(fixture);
    assert.ok(events.some(value => value.name === 'ItemUpdated' && idKey(value.event.Item.Id) === idKey(ownerId)));
    assert.equal(events.some(value => value.name === 'ItemRemoved' || value.name === 'ItemAdded'), false);
    if (marker) assert.equal(await readFile(marker, 'utf8'), 'owned marker');
  });

  databaseTest('D3 preview does not cache absence before an ignore file appears during preflight', async t => {
    const { fixture } = await setup(t, dialect, common), { errors } = assertions(fixture);
    let validations = 0, saves = 0;
    fixture.registry.register({ id: 'ignore-preflight', name: 'Ignore preflight', providers: [{
      id: 'writer', name: 'Controlled ignore writer', kind: 'saver', itemTypes: ['Trailer'], isEnabledFor: () => true,
      async validateSave() {
        validations++;
        await fixture.vfs.write('/owned-discovery-write/owned-discovery/.ignore', Buffer.from('*.mkv'), {
          modified: '2025-01-03T04:05:06.0000000Z'
        });
      },
      save() { saves++; return []; }
    }] });
    const original = fixture.host.loadContext;
    const configured = Object.assign(async (...args) => {
      const loaded = await original(...args);
      loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Controlled ignore writer'] };
      loaded.loadDraftContext = item => configured(item.Id, { draft: item });
      return loaded;
    }, original);
    fixture.host.loadContext = configured;
    await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(validations, 1); assert.equal(saves, 0);
    assert.deepEqual(await getExtra(fixture), []); assert.deepEqual(errors, []);
  });

  for (const audio of [false, true]) databaseTest(`first ${audio ? 'audio' : 'trailer'} refresh saves a live extra with Updated events`, async t => {
    const { fixture } = await setup(t, dialect, { ...common, files: [audio ? 'theme.mp3' : 'primary-trailer.mkv'] });
    await fixture.database.update('BaseItems', { Id: ownerId }, { Genres: 'Owner genre', Overview: 'Owner overview', DateLastRefreshed: fixture.now });
    if (audio) fixture.host.supportedItemTypes = [...fixture.host.supportedItemTypes, 'Audio'];
    const { errors, events } = assertions(fixture);
    await fixture.host.refresh(ownerId, noMetadata);
    const [extra] = await getExtra(fixture);
    assert.ok(extra); assert.equal(extra.ExtraType, audio ? 8 : 2);
    assert.equal(extra.Type, audio ? 'MediaBrowser.Controller.Entities.Audio.Audio' : 'MediaBrowser.Controller.Entities.Trailer');
    assert.equal(idKey(extra.OwnerId), idKey(ownerId)); assert.equal(extra.ParentId, null); assert.equal(extra.TopParentId, null);
    assert.equal(extra.Overview, 'Owner overview'); assert.equal(extra.Genres, 'Owner genre');
    assert.equal(extra.Name, audio ? 'Theme Song' : 'Trailer');
    assert.equal(extra.DateLastSaved != null, true); assert.equal(extra.DateLastRefreshed, null);
    const data = parseLosslessJson(extra.Data);
    assert.equal(data.Size, 16); assert.ok(Array.isArray(audio ? data.LyricFiles : data.TrailerTypes));
    assert.equal(events.filter(value => value.name === 'ItemAdded' && idKey(value.event.Item.Id) === idKey(extra.Id)).length, 0);
    assert.ok(events.some(value => value.name === 'ItemUpdated' && idKey(value.event.Item.Id) === idKey(extra.Id)));
    assert.deepEqual(errors, []);
    const saved = structuredClone(extra); events.length = 0;
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual((await getExtra(fixture))[0], saved);
    assert.equal(events.some(value => idKey(value.event.Item.Id) === idKey(extra.Id)), false);
  });

  for (const type of ['Series', 'Season', 'MusicArtist', 'MusicAlbum']) databaseTest(`${type} directory owner saves its newly discovered trailer`, async t => {
    const { fixture } = await setup(t, dialect, { ...common, expectedType: type, ownerPath: 'primary', files: ['primary/trailer.mkv'] });
    await fixture.database.update('BaseItems', { Id: ownerId }, { Genres: 'Directory genre', Overview: 'Directory overview', DateLastRefreshed: fixture.now });
    const { errors, events } = assertions(fixture);
    await fixture.host.refresh(ownerId, noMetadata);
    const [extra] = await getExtra(fixture);
    assert.ok(extra); assert.equal(extra.ExtraType, 2); assert.equal(extra.Type, 'MediaBrowser.Controller.Entities.Trailer');
    assert.equal(extra.Name, 'Trailer'); assert.equal(idKey(extra.OwnerId), idKey(ownerId));
    assert.equal(extra.ParentId, null); assert.equal(extra.TopParentId, null);
    assert.equal(extra.Genres, 'Directory genre'); assert.equal(extra.Overview, 'Directory overview');
    assert.ok(events.some(value => value.name === 'ItemUpdated' && idKey(value.event.Item.Id) === idKey(extra.Id)));
    assert.equal(events.some(value => value.name === 'ItemAdded'), false); assert.deepEqual(errors, []);
  });

  databaseTest('new extra inherits live owner title before the owner is persisted', async t => {
    const { fixture, loaded } = await setup(t, dialect, common), { errors } = assertions(fixture);
    const before = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), true);
    const [extra] = await getExtra(fixture);
    assert.equal(extra.Genres, 'Owner genre'); assert.equal(extra.Overview, 'Owner overview');
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: ownerId } }), before);
    assert.deepEqual(errors, []);
  });

  databaseTest('already cancelled discovery leaves no new extra row or event', async t => {
    const { fixture, loaded } = await setup(t, dialect, common), { errors, events } = assertions(fixture);
    const before = await fixture.database.rows('BaseItems');
    const reason = Object.assign(new Error('Controlled cancellation'), { code: 'controlled-owned-cancellation' });
    const signal = AbortSignal.abort(reason);
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal }), { message: reason.message, code: reason.code });
    assert.equal(signal.aborted, true);
    assertOwnedErrors(t, errors, error => error.code === reason.code || error.code === 'cancelled');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.deepEqual(events, []);
    const id = loaded.getNewItemId(path.join(fixture.stateRoot, 'media', 'primary-trailer.mkv'), 'MediaBrowser.Controller.Entities.Trailer');
    assert.equal(await loaded.videoVersionDiscovery.lookup(loaded, id), null);
  });

  databaseTest('new extra insert failure permits the owner provider but publishes no extra event', async t => {
    const { fixture } = await setup(t, dialect, { ...common, newFailure: 'insert' }), { errors, events } = assertions(fixture);
    const sqlFailures = observeSqlFailures(fixture);
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(await getExtra(fixture), []);
    assert.ok(sqlFailures.some(error => error.code === 'P0001' && error.message === 'Controlled owned discovery failure'));
    t.diagnostic(JSON.stringify({ sqlFailureDiagnostics: sqlFailures }));
    assertOwnedErrors(t, errors, error => error.code === 'P0001' && error.message === 'Controlled owned discovery failure');
    await assertOwnerSaved(fixture);
    assert.equal((await fixture.vfs.stat('/owned-discovery-write/owned-discovery/primary-trailer.mkv')).kind, 'file');
    assert.equal(events.some(value => idKey(value.event.Item.Id) !== idKey(ownerId)), false);
    assert.ok(events.some(value => value.name === 'ItemUpdated' && idKey(value.event.Item.Id) === idKey(ownerId)));
  });

  databaseTest('a stale owner rejects its new extra before any save', async t => {
    const { fixture, loaded } = await setup(t, dialect, common), { events } = assertions(fixture);
    await fixture.database.update('BaseItems', { Id: ownerId }, { Name: 'Competing owner' });
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.deepEqual(await getExtra(fixture), []); assert.deepEqual(events, []);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0].Name, 'Competing owner');
  });

  databaseTest('a competing row cannot replace a previously resolved new extra', async t => {
    const { fixture, loaded } = await setup(t, dialect, common), { events } = assertions(fixture);
    const refresh = fixture.host.refreshOwnedItem.bind(fixture.host); let competing;
    fixture.host.ownedLifecycle.refreshOwnedItem = async (owner, child, options, inheritance) => {
      const [source] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
      competing = { ...source, Id: child.Id, Type: child.NativeType, Path: child.Path, ParentId: null, OwnerId: ownerId, Name: 'Competing extra', ExtraType: 2 };
      await fixture.database.insert('BaseItems', competing);
      return refresh(owner, child, options, inheritance);
    };
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: competing.Id } }))[0], competing);
    assert.deepEqual(events, []);
  });

  databaseTest('a changed owner is rejected again inside the first extra save transaction', async t => {
    const { fixture, loaded } = await setup(t, dialect, common), { events } = assertions(fixture);
    const repository = fixture.host.updates.updateRepository.bind(fixture.host.updates);
    fixture.host.updates.updateRepository = (context, result, reason, options) => repository(context, result, reason, {
      ...options,
      async persist(_, metadata, saveOptions) {
        await fixture.database.update('BaseItems', { Id: ownerId }, { Name: 'Owner changed before insert' });
        return persistMetadata(fixture.store, context, metadata, saveOptions);
      }
    });
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.deepEqual(await getExtra(fixture), []); assert.deepEqual(events, []);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0].Name, 'Owner changed before insert');
  });

  for (const directoryOwner of [false, true]) databaseTest(`D3 validates a prospective ${directoryOwner ? 'directory' : 'file'} extra before missing extra deletion`, async t => {
    const { fixture, oldId } = await setup(t, dialect, { ...common,
      ...(directoryOwner ? { expectedType: 'MusicAlbum', ownerPath: 'primary' } : {}),
      files: directoryOwner ? ['primary/previous-trailer.mkv', 'primary/trailer.mkv'] : ['previous-trailer.mkv', 'primary-trailer.mkv'],
      existingType: true, missing: true, oldName: 'Trailer' });
    const { events } = assertions(fixture);
    fixture.registry.register({ id: 'extra-writer-preflight', name: 'Extra writer preflight', providers: [{
      id: 'writer', name: 'Controlled extra writer', kind: 'saver', itemTypes: ['Trailer'],
      isEnabledFor: () => true,
      validateSave() { throw Object.assign(new Error('Controlled extra destination unavailable'), { status: 501 }); },
      save() { throw new Error('D3 must precede saver dispatch'); }
    }] });
    const original = fixture.host.loadContext;
    const configured = Object.assign(async (...args) => {
      const loaded = await original(...args);
      loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Controlled extra writer'] };
      loaded.loadDraftContext = item => configured(item.Id, { draft: item });
      return loaded;
    }, original);
    fixture.host.loadContext = configured;
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.refresh(ownerId, noMetadata), { message: 'Controlled extra destination unavailable', status: 501 });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.deepEqual(events, []);
    assert.ok((await fixture.database.rows('BaseItems', { where: { Id: oldId } })).length);
    assert.equal((await getExtra(fixture)).length, 1);
    const old = (await fixture.loadContext(oldId)).item;
    assert.equal((await readFile(path.join(internalImagePath(old, (await fixture.loadContext(ownerId)).metadataPath), 'marker.txt'))).toString(), 'owned marker');
  });

  databaseTest('a failed extra task waits for every other owned task before returning', async t => {
    const { fixture, loaded } = await setup(t, dialect, { ...common, files: ['extras/other.mkv', 'extras/some.mkv'] });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), otherStarted = new Promise(resolve => { started = resolve; });
    const failure = Object.assign(new Error('Controlled extra failure'), { code: 'controlled-owned-task-failure' });
    fixture.host.ownedLifecycle.refreshOwnedItem = async (_, child) => {
      if (child.Name === 'other') throw failure;
      started(); await gate;
    };
    let completed = false;
    const result = fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata);
    const observed = result.then(() => { completed = true; }, () => { completed = true; });
    await otherStarted;
    // Flush the first task's rejection without releasing the second task.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    release(); await assert.rejects(result, { message: failure.message, code: failure.code }); await observed;
    assert.equal(completed, true);
    assert.deepEqual(await getExtra(fixture), []);
  });

  databaseTest('a weak snapshot preserves missing extras and their state files', async t => {
    const { fixture, loaded, oldId } = await setup(t, dialect, { ...common, existingType: true, missing: true, oldName: 'Trailer' });
    const list = fixture.adapter.listPage.bind(fixture.adapter);
    fixture.adapter.listPage = async (...args) => ({ ...await list(...args), consistency: 'weak', snapshot: null, deletionSafe: false });
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    assert.equal(old.Name, 'Trailer');
    assert.equal((await readFile(path.join(internalImagePath(old, loaded.metadataPath), 'marker.txt'))).toString(), 'owned marker');
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: oldId } })).length, 1);
    assert.equal((await fixture.vfs.list('/owned-discovery-write/owned-discovery')).entries.some(entry => entry.name === 'primary.mkv'), true);
  });

  databaseTest('a newly saved audio extra is removed independently after its file disappears', async t => {
    const { fixture } = await setup(t, dialect, { ...common, files: ['theme.mp3'] });
    fixture.host.supportedItemTypes = [...fixture.host.supportedItemTypes, 'Audio'];
    const { events, errors } = assertions(fixture);
    await fixture.host.refresh(ownerId, noMetadata); const [extra] = await getExtra(fixture);
    assert.ok(extra); events.length = 0;
    await fixture.adapter.delete('/owned-discovery/theme.mp3');
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal: AbortSignal.abort(new Error('Audio removal cancellation')) }), { message: 'Audio removal cancellation' });
    assert.deepEqual(await getExtra(fixture), []);
    assert.deepEqual(events.map(value => [value.name, nativeGuid(value.event.Item.Id)]), [['ItemRemoved', extra.Id]]);
    assert.deepEqual(errors, []);
  });
}
