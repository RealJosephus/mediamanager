import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryService } from '../../src/library/library-service.js';
import { ChannelService } from '../../src/library/channel-service.js';
import { nativeGuid } from '../../src/users/native.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { openScenario, within, removeOwnedDirectory } from './fixtures/channels/scenario.js';

export const requiredValidationServices = ['postgres'];

test('an empty installed Channel catalog ignores damaged unrelated roots, retains GetRange errors and drains its admitted user lookup', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-empty-catalog-'));
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  let fixture, pending, closing;
  const empty = { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  try {
    fixture = await openScenario({ name: 'empty inventory', providers: [], seeds: [], query: {}, user: true }, {
      metadataPath: path.join(root, 'metadata'), beforeRows: [], identities: [], userData: [],
    }, root);
    const rootId = nativeGuid(fixture.library.options.userRoot.Id);
    await fixture.database.insertBatch('BaseItems', [
      postgresTestRow('BaseItems', { Id: rootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'Unrelated user root', IsFolder: true, Data: '{}' }),
      postgresTestRow('BaseItems', { Id: nativeGuid('cf100000000000000000000000000010'), ParentId: rootId,
        Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Damaged unrelated library', IsFolder: true,
        Data: '{"PhysicalFolderIds":["not-a-guid"]}' }),
      postgresTestRow('BaseItems', { Id: nativeGuid('cf100000000000000000000000000011'),
        Type: 'MediaBrowser.Controller.Channels.Channel', Name: 'Retained uninstalled channel', IsFolder: true, Data: '{}' }),
    ]);
    const before = await fixture.snapshot();
    await assert.rejects(fixture.library.getViews({}, { user: fixture.user }), { status: 400, message: 'Invalid GUID.' },
      'The unrelated root really fails when a root consumer hydrates it.');
    for (const query of [{ UserId: fixture.user.Id }, { UserId: fixture.user.Id, StartIndex: 0, Limit: 0,
      IsRecordingsFolder: false, SupportsLatestItems: true, SupportsMediaDeletion: false, IsFavorite: true },
    { Limit: -9, IsFavorite: true }]) {
      assert.deepEqual(await fixture.channels.getChannelsInternal(query), empty);
      assert.deepEqual(await fixture.channels.getChannels(query), empty);
    }
    for (const [query, parameter] of [[{ StartIndex: -1, Limit: -9 }, 'index'], [{ StartIndex: 1 }, 'count'],
      [{ StartIndex: 1, Limit: 1 }, 'count']]) {
      for (const read of [query => fixture.channels.getChannelsInternal(query), query => fixture.channels.getChannels(query)]) {
        await assert.rejects(read(query), { status: 400, message: `Non-negative number required. (Parameter '${parameter}')` });
      }
    }
    assert.deepEqual(await fixture.snapshot(), before);
    const getUser = fixture.channels.users.getUser;
    fixture.channels.users.getUser = async id => { entered.resolve(); await proceed.promise; return getUser(id); };
    pending = fixture.channels.getChannels({ UserId: fixture.user.Id });
    await within(entered.promise, 'empty catalog admitted user lookup');
    let closed = false; closing = fixture.channels.close().then(() => { closed = true; });
    fixture.metadata.cancel();
    await assert.rejects(fixture.channels.getChannels(), { status: 503 });
    assert.equal(closed, false);
    proceed.resolve();
    assert.deepEqual(await within(pending, 'empty catalog user lookup drain'), empty);
    await within(closing, 'empty catalog close drain');
    assert.equal(closed, true); assert.deepEqual(await fixture.snapshot(), before); assert.deepEqual(fixture.diagnostics, []);
  } finally {
    proceed.resolve(); await Promise.allSettled([pending, closing]);
    try { await fixture?.close(); } finally { await removeOwnedDirectory(os.tmpdir(), root); }
  }
});

test('Channel capability filters preserve creation and range errors before skipping an unrelated damaged root', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-filtered-catalog-'));
  let fixture;
  const empty = { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  try {
    fixture = await openScenario({ name: 'installed without latest capability',
      providers: [{ name: 'Only', kind: 'plain', features: {} }], seeds: [], query: {}, user: true,
      policy: { BlockedTags: ['blocked'] } }, {
      metadataPath: path.join(root, 'metadata'), beforeRows: [], identities: [], userData: [],
    }, root);
    assert.deepEqual(await fixture.channels.getChannelsInternal({ UserId: fixture.user.Id, SupportsLatestItems: true }), empty);
    const installed = (await fixture.database.rows('BaseItems')).filter(row => row.Type === 'MediaBrowser.Controller.Channels.Channel');
    assert.equal(installed.length, 1);
    assert.equal(installed[0].Name, 'Only', 'The installed root must be persisted before capability filters discard it.');
    const rootId = nativeGuid(fixture.library.options.userRoot.Id);
    await fixture.database.insertBatch('BaseItems', [
      postgresTestRow('BaseItems', { Id: rootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'Unrelated user root', IsFolder: true, Data: '{}' }),
      postgresTestRow('BaseItems', { Id: nativeGuid('cf100000000000000000000000000010'), ParentId: rootId,
        Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Damaged unrelated library', IsFolder: true,
        Data: '{"PhysicalFolderIds":["not-a-guid"]}' }),
    ]);
    const before = await fixture.snapshot();
    await assert.rejects(fixture.library.getViews({}, { user: fixture.user }), { status: 400, message: 'Invalid GUID.' });
    for (const read of [query => fixture.channels.getChannelsInternal(query), query => fixture.channels.getChannels(query)]) {
      assert.deepEqual(await read({ UserId: fixture.user.Id, SupportsLatestItems: true, IsFavorite: true }), empty);
      assert.deepEqual(await read({ SupportsLatestItems: true, IsFavorite: true, Limit: -1 }), empty);
      await assert.rejects(read({ UserId: fixture.user.Id, SupportsLatestItems: true, StartIndex: 1 }),
        { status: 400, message: "Non-negative number required. (Parameter 'count')" });
      await assert.rejects(read({ UserId: fixture.user.Id, SupportsLatestItems: true, StartIndex: -1 }),
        { status: 400, message: "Non-negative number required. (Parameter 'index')" });
      await assert.rejects(read({ SupportsLatestItems: false, IsFavorite: true }),
        { status: 400, message: "Value cannot be null. (Parameter 'user')" });
      await assert.rejects(read({ UserId: fixture.user.Id, SupportsLatestItems: false }), { status: 400, message: 'Invalid GUID.' });
    }
    assert.deepEqual(await fixture.snapshot(), before);
    await within(fixture.channels.close(), 'filtered catalog close');
    await assert.rejects(fixture.channels.getChannelsInternal(), { status: 503 });
    assert.deepEqual(fixture.diagnostics, []);
  } finally {
    try { await fixture?.close(); } finally { await removeOwnedDirectory(os.tmpdir(), root); }
  }
});

test('an admitted filter query reaches real Views after Channel close and metadata cancellation without new admission', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-lifecycle-'));
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  let fixture, pending, closing;
  try {
    fixture = await openScenario({ name: 'empty inventory', providers: [], seeds: [], query: {}, user: true }, {
      metadataPath: path.join(root, 'metadata'), beforeRows: [], identities: [], userData: [],
    }, root);
    const original = fixture.library.userViews.views.bind(fixture.library.userViews);
    let admissions = 0, reserved;
    const admit = fixture.channels.admitOperation.bind(fixture.channels);
    fixture.channels.admitOperation = (...args) => { admissions++; return admit(...args); };
    fixture.library.userViews.views = async (...args) => {
      reserved = fixture.library.channelViewsAccess; entered.resolve(); await proceed.promise; return original(...args);
    };
    const before = await fixture.snapshot();
    pending = fixture.library.queryItemFilters({ includeItemTypes: ['Movie'] }, { user: fixture.user });
    await within(entered.promise, 'query before its actual Views consumer'); assert.ok(reserved); assert.equal(admissions, 1);
    let closed = false; closing = fixture.channels.close().then(() => { closed = true; }); fixture.metadata.cancel();
    await assert.rejects(fixture.channels.getChannels(), { status: 503 });
    assert.equal(closed, false, 'The held real query still owns the provider reader.');
    proceed.resolve(); const result = await within(pending, 'admitted filter query drain'); await within(closing, 'channel close drain');
    assert.deepEqual(result, { Genres: [], Tags: [], AudioLanguages: [], SubtitleLanguages: [] });
    assert.equal(admissions, 2, 'Only the original reservation and the explicitly rejected new request entered admitOperation.');
    assert.equal(closed, true); assert.deepEqual(await fixture.snapshot(), before); assert.deepEqual(fixture.diagnostics, []); await fixture.released();
  } finally {
    proceed.resolve(); await Promise.allSettled([pending, closing]); try { await fixture?.close(); } finally { await removeOwnedDirectory(os.tmpdir(), root); }
  }
});

test('a rejected SQL admission releases the explicitly reserved Channel reader', async () => {
  const rejected = Object.assign(new Error('Controlled store admission rejection.'), { status: 503 });
  let permits = 0, releases = 0;
  const library = new LibraryService({ store: { run: () => Promise.reject(rejected) }, serverId: 'channel-admission' });
  library.channels = { admitOperation() { permits++; return { async release() { permits--; releases++; } }; } };
  try {
    await assert.rejects(library.queryItemFilters({}, { user: { Id: 'cf100000000000000000000000000001' } }), error => error === rejected);
    assert.equal(permits, 0); assert.equal(releases, 1);
    await assert.rejects(library.getItem('cf100000000000000000000000000001', {
      user: { Id: 'cf100000000000000000000000000001' }, limit: 'not-an-integer',
    }), error => error === rejected, 'Optional count admission must not validate the query before the existing item lookup.');
    assert.equal(permits, 0); assert.equal(releases, 2);
    await assert.rejects(library.queryLatestItems({ fields: [' ItemCounts '] }, {
      user: { Id: 'cf100000000000000000000000000001' },
    }), error => error === rejected);
    assert.equal(permits, 0); assert.equal(releases, 3);
  } finally { await library.close(); }
});

test('a provider failure after close drains the admitted read and releases its real metadata permit once', async () => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let permits = 0, releases = 0, pending, closing;
  const expected = new Error('Controlled feature failure.');
  const channels = new ChannelService({ plugins: { entries: () => [{ name: 'Held', getChannelFeatures: async () => { entered.resolve(); await finish.promise; throw expected; } }] },
    library: { options: { programDataPath: '/isolated', configuration: {} }, orderChannelProviders: async values => values,
      withChannelEntity: (_id, operation) => operation({ Type: 'Channel', Id: 'cf100000000000000000000000000001', Name: 'Held', ChannelId: '00000000000000000000000000000000' }) },
    users: { getUser: async () => null }, getMetadata: () => ({ admitShutdownDrain() { permits++; let released = false; return { run: operation => operation(), release() { if (!released) { released = true; permits--; releases++; } } }; } }) });
  try {
    pending = channels.getChannelFeatures('cf100000000000000000000000000001'); const rejected = assert.rejects(pending, error => error === expected);
    await within(entered.promise, 'held provider'); closing = channels.close(); await assert.rejects(channels.getAllChannelFeatures(), { status: 503 });
    assert.equal(permits, 1); finish.resolve(); await rejected; await within(closing, 'failed provider close'); assert.equal(permits, 0); assert.equal(releases, 1);
  } finally { finish.resolve(); await Promise.allSettled([pending, closing]); await channels.close(); }
});
