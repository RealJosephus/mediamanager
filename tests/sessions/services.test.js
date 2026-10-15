import { nativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { fixtureRow } from '../database/fixtures.js';
import { UserDataService, hydrateItem, guidN, sameGuid, userDataKeys, readUserData, saveUserData, itemVersions, applyVersionUserData, userDataDto } from '../../src/sessions/user-data.js';
import { SessionService } from '../../src/sessions/service.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import reference from './fixtures/http-reference.json' with { type: 'json' };
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const USER = 'AAAAAAAA-1111-1111-1111-111111111111';
const SECOND = 'BBBBBBBB-1111-1111-1111-111111111111';
const ITEM = '22222222-2222-2222-2222-222222222222';
const ALTERNATE = '33333333-3333-3333-3333-333333333333';
const LATER_ALTERNATE = '44444444-4444-4444-4444-444444444444';
const clock = () => new Date('2026-09-26T14:00:00.123Z');
async function seed(db) {
  for (const [Id, InternalId] of [[USER, 1n], [SECOND, 2n]]) await db.insert('Users', { ...fixtureRow(tableDefinition('Users')), Id, InternalId, Username: Id, NormalizedUsername: Id, RowVersion: 0n, LastActivityDate: null, RememberAudioSelections: true, RememberSubtitleSelections: true });
  for (const [Id, Name] of [[ITEM, 'Primary'], [ALTERNATE, 'Alternate']]) await db.insert('BaseItems', {
    ...fixtureRow(tableDefinition('BaseItems')), Id, Name, CleanName: Name.toLowerCase(), SortName: Name.toLowerCase(),
    ForcedSortName: null, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Data: '{}', ParentId: null, OwnerId: null,
    ChannelId: null, ExternalId: null, PrimaryVersionId: null, ExtraType: null, IsFolder: false, RunTimeTicks: 72000000000n
  });
}
async function services(db) {
  const store = new DomainStore(db);
  await store.transaction(seed);
  const administrators = new Map([[guidN(USER), true], [guidN(SECOND), false]]);
  const users = new EventEmitter();
  users.getUser = id => store.run(async db => {
    const user = (await db.rows('Users')).find(row => sameGuid(row.Id, id));
    return user ? { ...user, Policy: { IsAdministrator: administrators.get(guidN(user.Id)) ?? false,
      EnableAllDevices: true, EnableSharedDeviceControl: true } } : null;
  });
  users.setAdministrator = async (id, value) => {
    administrators.set(guidN(id), value);
    users.emit('UserUpdated', await users.getUser(id));
  };
  const library = {
    getItemRecord: (id) => store.run(async (db) => { const row = (await db.rows('BaseItems')).find((row) => sameGuid(row.Id, id)); return row ? hydrateItem(db, row) : null; }),
    getItemDto: async (item) => ({ Id: guidN(item.Id), Name: item.Name, RunTimeTicks: item.RunTimeTicks }),
  };
  const userData = new UserDataService({ store, library, users, clock });
  const sessions = new SessionService({ store, library, users, userData, serverId: 'server', clock, automaticProgress: false });
  return { store, users, library, userData, sessions };
}
test('postgres: concurrent persisted playback, key preference, alternate propagation and events', async t => {
    const db = await createPostgresTestDatabase(t, 'sessions_playback');
    let sessions;
    try {
      const context = await services(db); ({ sessions } = context);
      const { store, userData, users } = context;
      const events = [];
      userData.on('UserDataSaved', (event) => events.push(event));
      const auth = { Client: 'CoreFlow', Device: 'IsolatedTest', DeviceId: 'device', Version: '1', User: await users.getUser(USER) };
      const session = await sessions.logActivity(auth, { remoteEndPoint: '127.0.0.1' });
      await sessions.playbackStart(session.Id, { ItemId: ITEM, PositionTicks: 0n, PlayMethod: 'DirectPlay' });
      await Promise.all([userData.setFavorite(USER, ITEM, true), sessions.playbackProgress(session.Id, { ItemId: ITEM, PositionTicks: 36000000000n, AudioStreamIndex: 2, SubtitleStreamIndex: -1 })]);
      let dto = await userData.get(guidN(USER), guidN(ITEM));
      assert.equal(dto.IsFavorite, true); assert.equal(dto.PlayCount, 1); assert.equal(dto.PlaybackPositionTicks, 36000000000n); assert.equal(dto.PlayedPercentage, 50);
      await sessions.advanceProgress(session.Id);
      assert.equal(sessions.getSession(session.Id).PlayState.PositionTicks, 36010000000n);
      assert.equal((await userData.get(USER, ITEM)).PlaybackPositionTicks, 36000000000n, 'automated updates must not write progress');
      await sessions.playbackStopped(session.Id, { ItemId: ITEM, PositionTicks: 68400000000n, Failed: true });
      assert.equal((await userData.get(USER, ITEM)).PlaybackPositionTicks, 36000000000n);
      await sessions.playbackStopped(session.Id, { ItemId: ITEM, PositionTicks: 68400000000n });
      dto = await userData.get(USER, ITEM);
      assert.equal(dto.Played, true); assert.equal(dto.PlaybackPositionTicks, 0n); assert.equal(dto.PlayCount, 1);
      // Native UserDataManager emits after each transaction commits. The two
      // operations launched with Promise.all have no cross-request start order.
      assert.equal(events[0].SaveReason, 'PlaybackStart');
      assert.equal(events.at(-1).SaveReason, 'PlaybackFinished');
      assert.deepEqual(events.slice(1, -1).map(event => event.SaveReason).sort(), ['PlaybackProgress', 'UpdateUserRating']);
      assert.equal(events.find(event => event.SaveReason === 'UpdateUserRating').UserData.IsFavorite, true);
      assert.equal(events.find(event => event.SaveReason === 'PlaybackProgress').UserData.PlaybackPositionTicks, 36000000000n);
      await store.transaction(async (db) => {
        await db.insert('BaseItemProviders', { ItemId: ITEM, ProviderId: 'Tmdb', ProviderValue: '900' });
        await db.insert('LinkedChildren', { ParentId: ITEM, SortOrder: 0, ChildId: ALTERNATE, ChildType: 3 });
        await db.update('BaseItems', { Id: ALTERNATE }, { PrimaryVersionId: ITEM });
      });
      await userData.update(USER, ITEM, { PlaybackPositionTicks: 9007199254740993n });
      assert.equal(events.at(-1).SaveReason, 'UpdateUserData');
      assert.equal((await userData.get(USER, ITEM)).PlaybackPositionTicks, 9007199254740993n);
      assert.equal((await userData.get(USER, ITEM)).Key, '900');
      dto = await userData.update(USER, ITEM, { Likes: true });
      assert.equal(dto.Rating, 10); assert.equal(dto.Likes, true);
      dto = await userData.update(USER, ITEM, { Likes: true, Rating: 2 });
      assert.equal(dto.Rating, 2); assert.equal(dto.Likes, false, 'the explicit rating is applied after Likes');
      let ratingRows = await store.run(db => db.rows('UserData', { where: { UserId: USER, ItemId: ITEM } }));
      assert.equal(ratingRows.every(row => row.Rating === 2 && row.Likes === false), true, 'the derived Likes column is normalized on save');
      await store.transaction(async db => {
        for (const row of await db.rows('UserData', { where: { UserId: USER, ItemId: ITEM } })) {
          await db.update('UserData', { UserId: row.UserId, ItemId: row.ItemId, CustomDataKey: row.CustomDataKey }, { Likes: true });
        }
      });
      assert.equal((await userData.get(USER, ITEM)).Likes, false, 'Rating remains authoritative when a persisted Likes column has drifted');
      dto = await userData.update(USER, ITEM, { Rating: 6.499 });
      assert.equal(dto.Likes, false);
      dto = await userData.update(USER, ITEM, { Rating: 6.5 });
      assert.equal(dto.Likes, true);
      await assert.rejects(userData.update(USER, ITEM, { Rating: 10.01 }), { status: 400 });
      dto = await userData.setLikes(USER, ITEM, true);
      assert.equal(dto.Rating, 10); assert.equal(dto.Likes, true);
      dto = await userData.setLikes(USER, ITEM, false);
      assert.equal(dto.Rating, 1); assert.equal(dto.Likes, false);
      dto = await userData.setLikes(USER, ITEM, null);
      assert.equal(dto.Rating, null); assert.equal(dto.Likes, null);
      await store.transaction(async (db) => { const item = await context.library.getItemRecord(ITEM); await saveUserData(db, USER, item, { ...(await readUserData(db, USER, item)), AudioStreamIndex: 5 }); });
      await userData.setPlayed(USER, ITEM, false);
      assert.equal((await userData.get(USER, ALTERNATE)).Played, false);
      await sessions.playbackStart(session.Id, { ItemId: ITEM, MediaSourceId: guidN(ALTERNATE) });
      await sessions.playbackStopped(session.Id, { ItemId: ITEM, MediaSourceId: guidN(ALTERNATE), PositionTicks: 70000000000n });
      assert.equal((await userData.get(USER, ALTERNATE)).PlayCount, 1);
      assert.equal((await userData.get(USER, ITEM)).Played, true);
      assert.equal((await userData.get(USER, ITEM)).PlayCount, 0, 'propagating completed alternate must preserve primary play count');
      await assert.rejects(sessions.playbackStopped(session.Id, { ItemId: ITEM, PositionTicks: -1n }), { status: 400 });
      const persisted = await store.run((db) => db.rows('UserData', { where: { UserId: USER } }));
      assert.equal(persisted.length, 3);
      assert.equal(persisted.filter((row) => row.ItemId === ITEM).every((row) => row.Played), true);
      assert.equal(persisted.every(row => row.Likes === null && row.Rating === null), true);
      assert.equal((await store.run((db) => db.rows('Users', { where: { Id: USER } })))[0].LastActivityDate, '2026-09-26 14:00:00.123');
    } finally {
      await sessions?.close();
      await db.close();
    }
  });

test('postgres: a later version user-data SQL failure preserves the committed save prefix', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_played_prefix');
  let sessions;
  try {
    const context = await services(db); ({ sessions } = context);
    const { store, userData } = context;
    await store.transaction(async database => {
      await database.insert('BaseItems', {
        ...fixtureRow(tableDefinition('BaseItems')), Id: LATER_ALTERNATE, Name: 'Later alternate',
        CleanName: 'later alternate', SortName: 'later alternate', ForcedSortName: null,
        Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Data: '{}', ParentId: null,
        OwnerId: null, ChannelId: null, ExternalId: null, PrimaryVersionId: ITEM,
        ExtraType: null, IsFolder: false, RunTimeTicks: 72000000000n,
      });
      await database.update('BaseItems', { Id: ALTERNATE }, { PrimaryVersionId: ITEM });
      await database.insert('LinkedChildren', { ParentId: ITEM, SortOrder: 0, ChildId: ALTERNATE, ChildType: 3 });
      await database.insert('LinkedChildren', { ParentId: ITEM, SortOrder: 1, ChildId: LATER_ALTERNATE, ChildType: 3 });
    });
    await db.client.query(`CREATE FUNCTION "${db.schemaName}".test_later_userdata_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."ItemId" = decode('${nativeTextBytes(LATER_ALTERNATE).toString('hex')}', 'hex') THEN
          RAISE EXCEPTION 'Injected later version user-data failure';
        END IF;
        RETURN NEW;
      END $$`);
    await db.client.query(`CREATE TRIGGER test_later_userdata_failure BEFORE INSERT OR UPDATE ON "UserData"
      FOR EACH ROW EXECUTE FUNCTION "${db.schemaName}".test_later_userdata_failure()`);
    const events = [];
    userData.on('UserDataSaved', event => events.push(event.Item.Id));

    await assert.rejects(userData.setPlayed(USER, ITEM, true), /Injected later version user-data failure/u);

    const rows = await db.rows('UserData', { where: { UserId: USER } });
    assert.deepEqual([...new Set(rows.map(row => row.ItemId))], [ITEM, ALTERNATE]);
    assert.equal(rows.filter(row => row.ItemId === ITEM).every(row => row.Played), true);
    assert.equal(rows.filter(row => row.ItemId === ALTERNATE).every(row => row.Played), true);
    assert.deepEqual(events, [ITEM, ALTERNATE]);
  } finally {
    await sessions?.close();
    await db.client.query('DROP TRIGGER IF EXISTS test_later_userdata_failure ON "UserData"');
    await db.client.query(`DROP FUNCTION IF EXISTS "${db.schemaName}".test_later_userdata_failure()`);
    await db.close();
  }
});

test('user data publishes its committed item cache inside the writer boundary and emits afterward', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_cache');
  const baseStore = new DomainStore(db);
  try {
    await baseStore.transaction(seed);
    const item = await baseStore.run(async database => hydrateItem(database,
      (await database.rows('BaseItems', { where: { Id: ITEM }, limit: 1 }))[0]));
    let writerBoundaryActive = false, publications = 0, cached = item.UserData;
    Object.defineProperty(item, 'UserData', {
      configurable: true,
      enumerable: true,
      get: () => cached,
      set: value => {
        assert.equal(writerBoundaryActive, true, 'the committed item cache must publish before releasing the writer lock');
        publications++;
        cached = value;
      }
    });
    const store = {
      run: (...args) => baseStore.run(...args),
      transaction: (...args) => baseStore.transaction(...args),
      serializeWrites: (operation, options) => baseStore.serializeWrites(async database => {
        writerBoundaryActive = true;
        try { return await operation(database); }
        finally { writerBoundaryActive = false; }
      }, options)
    };
    const userData = new UserDataService({ store,
      users: { getUser: async () => ({ Id: USER }) },
      library: { getItemRecord: async () => item }, clock });
    let emitted = false;
    userData.once('UserDataSaved', event => {
      assert.equal(writerBoundaryActive, false, 'event observers must not inherit the writer connection scope');
      assert.equal(event.Item, item);
      emitted = true;
    });

    await userData.setFavorite(USER, ITEM, true);

    assert.equal(publications, 1);
    assert.equal(emitted, true);
    assert.equal(cached.some(row => row.IsFavorite), true);
  } finally { db.close(); }
});

test('session ownership, capability permissions, deterministic identity and device logout', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_ownership');
  const { sessions, users } = await services(db);
  try {
    const firstAuth = { Client: 'App', Device: 'Device', DeviceId: 'same-device', Version: '1', User: await users.getUser(USER) };
    const secondAuth = { ...firstAuth, User: await users.getUser(SECOND) };
    const first = await sessions.logActivity(firstAuth);
    const second = await sessions.logActivity(secondAuth);
    assert.notEqual(first.Id, second.Id);
    assert.equal((await sessions.logActivity({ ...firstAuth, Version: '2' })).Id, first.Id);
    assert.equal((await sessions.getSessions(secondAuth)).length, 1);
    assert.equal((await sessions.getSessions(firstAuth)).length, 2);
    await assert.rejects(sessions.reportCapabilities(first.Id, { SupportsMediaControl: true }, { controllingSessionId: second.Id }), { status: 403 });
    await assert.rejects(sessions.addUser(second.Id, USER, { controllingSessionId: second.Id }), { status: 403 });
    await sessions.reportCapabilities(first.Id, { SupportsMediaControl: true, PlayableMediaTypes: ['Video'] }, { controllingSessionId: first.Id });
    assert.equal(sessions.getSession(first.Id).SupportsRemoteControl, false, 'capabilities alone do not provide a connected controller');
    assert.equal(sessions.getDeviceCapabilities('same-device').SupportsPersistentIdentifier, true);
    assert.equal(sessions.countUserSessions(USER), 1);
    assert.deepEqual(JSON.parse(stringifyNativeJson(first.PlayState)), { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' });
    await sessions.endByDevice('SAME-DEVICE');
    assert.equal((await sessions.getSessions(firstAuth)).length, 0);
  } finally { await sessions.close(); db.close(); }
});

test('native provider key order includes named and Unicode entities', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_keys');
  try {
    assert.deepEqual(await userDataKeys(db, { Id: ITEM, Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '2' } }), ['2', 'tt1', ITEM]);
    assert.deepEqual(await userDataKeys(db, { Id: ITEM, Type: 'Movie', ExtraType: 'Trailer', RunTimeTicks: 100n, ProviderIds: { Imdb: 'tt1', Tmdb: '2' } }), ['tt1-trailer-100', '2-trailer-100', ITEM]);
    assert.deepEqual(await userDataKeys(db, { Id: ITEM, Type: 'Person', Name: 'Café', ProviderIds: {} }), ['Person-Cafe', ITEM]);
  } finally { db.close(); }
});

test('user session messages are lazy, include additional-user sessions and share one message id', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_messages');
  const { sessions, users } = await services(db);
  try {
    const session = async (userId, deviceId) => sessions.logActivity({ User: await users.getUser(userId), Client: 'Messages', Device: 'Device', DeviceId: deviceId, Version: '1' });
    const primary = await session(USER, 'primary');
    const own = await session(SECOND, 'own');
    const primaryMessages = [], ownMessages = [];
    sessions.attachController(primary.Id, { isActive: () => true, supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => primaryMessages.push({ messageType, messageId, data }) });
    sessions.attachController(own.Id, { isActive: () => true, supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => ownMessages.push({ messageType, messageId, data }) });

    let payloads = 0;
    await sessions.sendMessageToUserSessions(['CCCCCCCC-1111-1111-1111-111111111111'], 'UserDataChanged', () => { payloads++; return {}; });
    assert.equal(payloads, 0, 'a payload factory is not evaluated without a matching session');

    await sessions.addUser(primary.Id, SECOND);
    await sessions.sendMessageToUserSessions([SECOND], 'UserDataChanged', () => { payloads++; return { UserId: guidN(SECOND) }; });
    assert.equal(payloads, 1);
    assert.equal(primaryMessages.length, 1);
    assert.equal(ownMessages.length, 1);
    assert.equal(primaryMessages[0].messageId, ownMessages[0].messageId);
    assert.match(primaryMessages[0].messageId, /^[0-9a-f]{32}$/);
    assert.deepEqual(primaryMessages[0].data, { UserId: guidN(SECOND) });
  } finally { await sessions.close(); db.close(); }
});

test('admin session messages use current primary or additional-user policy and exclude anonymous sessions', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_admin_messages');
  const { sessions, users } = await services(db);
  try {
    const connect = async (userId, deviceId) => {
      const session = await sessions.logActivity({ User: userId ? await users.getUser(userId) : null,
        Client: 'AdminMessages', Device: 'Device', DeviceId: deviceId, Version: '1' });
      const messages = [];
      sessions.attachController(session.Id, { isActive: () => true, supportsMediaControl: true,
        sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data }) });
      return { session, messages };
    };
    const reader = await connect(SECOND, 'reader');
    const anonymous = await connect(null, 'api-key');

    let payloads = 0;
    await sessions.sendMessageToAdminSessions('RefreshProgress', () => { payloads++; return { ItemId: ITEM }; });
    assert.equal(payloads, 0, 'a payload factory is not evaluated when no connected session contains an administrator');
    assert.deepEqual(reader.messages, []);
    assert.deepEqual(anonymous.messages, []);

    const admin = await connect(USER, 'admin');
    await sessions.addUser(reader.session.Id, USER);
    await sessions.sendMessageToAdminSessions('RefreshProgress', () => {
      payloads++;
      return { ItemId: ITEM, Progress: '25' };
    });

    assert.equal(payloads, 1);
    assert.equal(admin.messages.length, 1);
    assert.equal(reader.messages.length, 1, 'an administrator attached as an additional user targets the session');
    assert.equal(anonymous.messages.length, 0, 'an API-key/anonymous session has no administrator membership');
    assert.equal(admin.messages[0].messageId, reader.messages[0].messageId);
    assert.match(admin.messages[0].messageId, /^[0-9a-f]{32}$/);
    assert.deepEqual(admin.messages[0], {
      messageType: 'RefreshProgress',
      messageId: reader.messages[0].messageId,
      data: { ItemId: ITEM, Progress: '25' }
    });

    admin.messages.length = 0;
    reader.messages.length = 0;
    await users.setAdministrator(USER, false);
    await sessions.sendMessageToAdminSessions('RefreshProgress', { ItemId: ITEM, Progress: '50' });
    assert.deepEqual(admin.messages, [], 'demotion takes effect without reconnecting the primary session');
    assert.deepEqual(reader.messages, [], 'demotion also removes additional-user administrator targeting');

    await users.setAdministrator(SECOND, true);
    await sessions.sendMessageToAdminSessions('RefreshProgress', { ItemId: ITEM, Progress: '75' });
    assert.deepEqual(admin.messages, [], 'an unrelated demoted session remains excluded');
    assert.equal(reader.messages.length, 1, 'promotion takes effect without reconnecting the primary session');
    assert.deepEqual(reader.messages[0].data, { ItemId: ITEM, Progress: '75' });
  } finally { await sessions.close(); db.close(); }
});

test('version traversal includes local versions of linked items and preserves native winner ties', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_versions');
  const { store, sessions, library } = await services(db);
  const local = '44444444-4444-4444-4444-444444444444';
  const linked = '55555555-5555-5555-5555-555555555555';
  try {
    await store.transaction(async db => {
      const template = (await db.rows('BaseItems', { where: { Id: ITEM } }))[0];
      await db.insert('BaseItems', { ...template, Id: local, SortName: 'local', PrimaryVersionId: ALTERNATE });
      await db.insert('BaseItems', { ...template, Id: linked, Name: 'first', CleanName: 'first', SortName: 'first', PrimaryVersionId: ITEM });
      await db.update('BaseItems', { Id: ALTERNATE }, { Name: 'second', CleanName: 'second', SortName: 'second', PrimaryVersionId: ITEM });
      await db.insert('LinkedChildren', { ParentId: ITEM, SortOrder: 0, ChildId: ALTERNATE, ChildType: 3 });
      await db.insert('LinkedChildren', { ParentId: ITEM, SortOrder: 1, ChildId: linked, ChildType: 3 });
      await db.insert('LinkedChildren', { ParentId: ALTERNATE, SortOrder: 0, ChildId: local, ChildType: 2 });
      const primary = await library.getItemRecord(ITEM);
      const alternate = await library.getItemRecord(ALTERNATE);
      assert.deepEqual((await itemVersions(db, primary)).map(item => item.Id), [ITEM, linked, ALTERNATE, local]);
      assert.deepEqual((await itemVersions(db, alternate)).map(item => item.Id), [ALTERNATE, ITEM, linked, local]);
      await saveUserData(db, USER, primary, { ...await readUserData(db, USER, primary), PlaybackPositionTicks: 40000000000n, LastPlayedDate: '2026-09-26 12:00:00' });
      await saveUserData(db, USER, alternate, { ...await readUserData(db, USER, alternate), Played: true, LastPlayedDate: '2026-09-26 12:00:00.0000000' });
      const own = userDataDto(primary, await readUserData(db, USER, primary));
      assert.equal((await applyVersionUserData(db, USER, primary, own)).Played, false, 'equal native times keep the first candidate');
      await saveUserData(db, USER, alternate, { ...await readUserData(db, USER, alternate), LastPlayedDate: '2026-09-26 12:00:00.0000001' });
      const completed = await applyVersionUserData(db, USER, primary, own);
      assert.equal(completed.Played, true);
      assert.equal(completed.PlaybackPositionTicks, 0n);
      assert.equal(completed.LastPlayedDate, '2026-09-26T12:00:00.0000001Z');
    });
  } finally { await sessions.close(); db.close(); }
});

test('actual reference HTTP session and user data response projection', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_reference');
  const { store, sessions, userData, users } = await services(db);
  try {
    const recorded = name => structuredClone(reference.cases.find(entry => entry.name === name).body);
    const expected = recorded('sessions')[0];
    const id = nativeGuid(expected.UserId);
    await store.transaction(db => db.update('Users', { Id: USER }, { Id: id, Username: expected.UserName }));
    sessions.serverId = expected.ServerId;
    const auth = { User: await users.getUser(id), Client: expected.Client, Device: expected.DeviceName, DeviceId: expected.DeviceId, Version: expected.ApplicationVersion };
    const actual = await sessions.logActivity(auth, { remoteEndPoint: expected.RemoteEndPoint });
    expected.LastActivityDate = actual.LastActivityDate;
    assert.deepEqual(JSON.parse(stringifyNativeJson(actual)), expected, 'only the controlled activity timestamp is normalized');
    const caps = recorded('sessions-capabilities')[0];
    await sessions.reportCapabilities(actual.Id, caps.Capabilities, { controllingSessionId: actual.Id });
    caps.LastActivityDate = actual.LastActivityDate;
    assert.deepEqual(JSON.parse(stringifyNativeJson(sessions.getSession(actual.Id))), caps);
    await userData.setFavorite(id, ITEM, true);
    assert.deepEqual(JSON.parse(stringifyNativeJson(await userData.get(id, ITEM))), recorded('userdata-favorite'));
    await sessions.playbackStart(actual.Id, { ItemId: ITEM, PositionTicks: 0n });
    await sessions.playbackProgress(actual.Id, { ItemId: ITEM, PositionTicks: 36000000000n });
    const progress = recorded('userdata-progress'); progress.LastPlayedDate = '2026-09-26T14:00:00.123Z';
    assert.deepEqual(JSON.parse(stringifyNativeJson(await userData.get(id, ITEM))), progress);
    await sessions.playbackStopped(actual.Id, { ItemId: ITEM, PositionTicks: 68400000000n });
    const stopped = recorded('userdata-stopped'); stopped.LastPlayedDate = progress.LastPlayedDate;
    assert.deepEqual(JSON.parse(stringifyNativeJson(await userData.get(id, ITEM))), stopped);
  } finally { await sessions.close(); db.close(); }
});

test('idle playback persists the actual client check-in instead of automatic progress', async t => {
  const db = await createPostgresTestDatabase(t, 'sessions_idle');
  const { sessions, users, userData } = await services(db);
  try {
    const session = await sessions.logActivity({ User: await users.getUser(USER), Client: 'App', DeviceId: 'idle', Device: 'Device', Version: '1' });
    await sessions.playbackStart(session.Id, { ItemId: ITEM, PositionTicks: 36000000000n });
    await sessions.advanceProgress(session.Id);
    sessions.clock = () => new Date('2026-09-26T14:05:00.124Z');
    await sessions.checkIdlePlayback();
    assert.equal(sessions.getSession(session.Id).NowPlayingItem, null);
    assert.equal((await userData.get(USER, ITEM)).PlaybackPositionTicks, 36000000000n);
  } finally { await sessions.close(); db.close(); }
});
