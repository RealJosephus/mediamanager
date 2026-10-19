import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService, playlistNativeType } from '../../src/library/playlist-service.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { acquireNativeItemLinkOwner } from '../../src/library/native-item-entity.js';
import { attachStateDeletion, createStateRelations, closeStateDeletion } from './deletion-fixture.js';

const ids = {
  owner: nativeGuid('71000000000000000000000000000001'),
  editor: nativeGuid('71000000000000000000000000000002'),
  viewer: nativeGuid('71000000000000000000000000000003'),
  first: nativeGuid('72abcdef000000000000000000000001'),
  second: nativeGuid('72000000000000000000000000000002'),
  folder: nativeGuid('72000000000000000000000000000003')
};
const policy = (admin = false) => ({ IsAdministrator: admin, EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
  BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], EnableContentDeletionFromFolders: [] });
const user = (Id, admin = false) => ({ Id, Policy: policy(admin), MaxParentalRatingScore: null, MaxParentalRatingSubScore: null });
const normalizedShares = shares => shares.map(share => ({ ...share, UserId: idKey(share.UserId) }));
const normalizedPlaylist = playlist => ({ ...playlist, Shares: normalizedShares(playlist.Shares) });
const normalizedShare = share => ({ ...share, UserId: idKey(share.UserId) });
const normalizedPlaylistData = data => ({ ...data, OwnerUserId: idKey(data.OwnerUserId), Shares: normalizedShares(data.Shares) });
const item = (Id, Type, Path, values = {}) => ({
  Id, Type, Name: path.basename(Path), CleanName: path.basename(Path).toLowerCase(), SortName: path.basename(Path).toLowerCase(),
  Path, IsFolder: false, IsInMixedFolder: false, IsLocked: false, IsMovie: Type.endsWith('.Movie'),
  IsRepeat: false, IsSeries: false, IsVirtualItem: false, MediaType: 'Video', UnratedType: 'Movie', Data: '{}', ...values
});

async function dropPostgresSchemas(database) {
  const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
  await client.connect();
  try {
    for (const name of [database.schemaName, database.controlSchema]) {
      await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
    }
  } finally { await client.end(); }
}

async function waitForFile(filename, accept = () => true, errors = []) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (errors.length) throw new AggregateError([...errors], 'Queued playlist XML save failed.');
    try {
      const contents = await readFile(filename, 'utf8');
      if (accept(contents)) return contents;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

function localInvariant(value) {
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  const two = entry => String(entry).padStart(2, '0');
  return `${two(date.getMonth() + 1)}/${two(date.getDate())}/${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

for (const dialect of ['postgres']) test(`${dialect}: managed playlists preserve duplicate order, permissions and filesystem/database rollback`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `playlist_${process.pid}_${randomBytes(4).toString('hex')}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-playlist-'));
  const programDataPath = path.join(directory, 'program'), dataPath = path.join(directory, 'explicit-data');
  const spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await createStateRelations(database, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'playlist-tests', programDataPath, dataPath, configuration: {} });
  const itemCreation = attachStateDeletion({ store, library, linkedChildren, spoolRoot });
  const errors = [];
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, programDataPath, dataPath, configuration: {},
    clock: () => new Date('2026-10-04T08:09:10.123Z'), onError: error => errors.push(error) });
  let closed = false;
  try {
    await initializeLibraryRoot({fileSystem: testFileSystem,  store, programDataPath, dataPath, configuration: {}, now: () => '2026-10-04T08:00:00.000Z' });
    await store.transaction(async db => {
      await db.insert('BaseItems', item(ids.first, 'MediaBrowser.Controller.Entities.Movies.Movie', path.join(directory, 'first.mkv')));
      await db.insert('BaseItems', item(ids.second, 'MediaBrowser.Controller.Entities.Movies.Movie', path.join(directory, 'second.mkv')));
      await db.insert('BaseItems', item(ids.folder, 'MediaBrowser.Controller.Entities.Folder', path.join(directory, 'folder'), {
        IsFolder: true, IsMovie: false, MediaType: 'Unknown', UnratedType: 'Other'
      }));
    });
    const owner = user(ids.owner), editor = user(ids.editor), added = [], updated = [], removed = [];
    library.on('ItemAdded', event => added.push(event));
    library.on('ItemUpdated', event => updated.push(event));
    library.on('ItemRemoved', event => removed.push(event));

    for (const unsafe of ['', '.', '..', path.resolve(directory, 'escape')]) {
      await assert.rejects(playlists.create({ name: unsafe, user: owner }), error => error.status === 400);
    }
    const beforeUnsafe = await readdir(path.join(dataPath, 'playlists'));
    assert.deepEqual(beforeUnsafe, []);

    const first = await playlists.create({ name: 'Road:Trip', ids: [ids.first, ids.second, ids.first], user: owner,
      users: [{ UserId: editor.Id, CanEdit: true }], isPublic: false });
    assert.match(first.Id, /^[0-9a-f]{32}$/u);
    const firstNativeId = nativeGuid(first.Id);
    const row = (await database.rows('BaseItems', { where: { Id: firstNativeId } }))[0];
    assert.equal(row.Type, playlistNativeType);
    assert.equal(row.MediaType, 'Video');
    assert.equal(row.DateLastMediaAdded, '2026-10-04 08:09:10.123');
    assert.equal(path.dirname(row.Path), path.join(dataPath, 'playlists'));
    assert.equal(path.basename(row.Path), 'Road Trip');
    assert.deepEqual(normalizedPlaylistData(JSON.parse(row.Data)), { OwnerUserId: idKey(owner.Id), OpenAccess: false,
      Shares: [{ UserId: idKey(editor.Id), CanEdit: true }], PlaylistMediaType: 'Video' });
    const parentRows = await database.rows('AncestorIds', { where: { ItemId: firstNativeId } });
    assert.equal(parentRows.length, 2);
    assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: firstNativeId } }))
      .map(link => idKey(link.ChildId)), [idKey(ids.first), idKey(ids.second), idKey(ids.first)]);
    assert.equal(added.length, 1);
    assert.equal(added[0].Item.Id, firstNativeId);
    const sidecar = await waitForFile(path.join(row.Path, 'playlist.xml'), contents =>
      (contents.match(/<PlaylistItem>/gu) ?? []).length === 3, errors);
    assert.equal(sidecar.charCodeAt(0), 0xfeff);
    assert.match(sidecar, new RegExp(`<Added>${localInvariant(row.DateCreated).replaceAll('/', '\\/')}</Added>`, 'u'));
    assert.doesNotMatch(sidecar, /<Added>[^<]* 24:/u);
    assert.match(sidecar, /<OwnerUserId>71000000000000000000000000000001<\/OwnerUserId>/u);
    assert.match(sidecar, /<PlaylistMediaType>Video<\/PlaylistMediaType>/u);
    assert.equal((sidecar.match(/<PlaylistItem>/gu) ?? []).length, 3);

    const collision = await playlists.create({ name: 'Road:Trip', user: owner });
    const collisionRow = (await database.rows('BaseItems', { where: { Id: nativeGuid(collision.Id) } }))[0];
    assert.equal(path.basename(collisionRow.Path), 'Road Trip1');
    assert.match(await waitForFile(path.join(collisionRow.Path, 'playlist.xml')), /<Shares \/>/u);
    const concurrent = await Promise.all([
      playlists.create({ name: 'Concurrent', user: owner }), playlists.create({ name: 'Concurrent', user: owner })
    ]);
    const concurrentPaths = [];
    for (const created of concurrent) concurrentPaths.push(path.basename((await database.rows('BaseItems', {
      where: { Id: nativeGuid(created.Id) }, limit: 1
    }))[0].Path));
    assert.deepEqual(concurrentPaths.sort(), ['Concurrent', 'Concurrent1']);

    assert.deepEqual(normalizedPlaylist(await playlists.get(first.Id, { user: owner })), {
      Shares: [{ UserId: idKey(editor.Id), CanEdit: true }], OpenAccess: false,
      ItemIds: [idKey(ids.first), idKey(ids.second), idKey(ids.first)]
    });
    await playlists.add(first.Id, [ids.second], { user: editor, position: 1 });
    assert.deepEqual((await playlists.get(first.Id, { user: owner })).ItemIds,
      [idKey(ids.first), idKey(ids.second), idKey(ids.second), idKey(ids.first)]);
    await playlists.move(first.Id, idKey(ids.second), 3, { user: editor });
    assert.deepEqual((await playlists.get(first.Id, { user: owner })).ItemIds,
      [idKey(ids.first), idKey(ids.second), idKey(ids.first), idKey(ids.second)]);
    await playlists.remove(first.Id, [idKey(ids.first).toUpperCase()], { user: editor });
    assert.equal((await playlists.get(first.Id, { user: owner })).ItemIds.length, 4, 'Removal is native case-sensitive.');
    await playlists.remove(first.Id, [idKey(ids.first)], { user: editor });
    assert.deepEqual((await playlists.get(first.Id, { user: owner })).ItemIds,
      [idKey(ids.second), idKey(ids.second)], 'One entry id removes every duplicate occurrence.');
    const page = await playlists.getItems(first.Id, { user: owner, startIndex: 1, limit: 1,
      dtoOptions: { EnableImages: false, EnableUserData: false } });
    assert.equal(page.TotalRecordCount, 2); assert.equal(page.StartIndex, 1); assert.equal(page.Items.length, 1);
    assert.equal(page.Items[0].PlaylistItemId, idKey(ids.second));
    assert.ok(updated.length >= 4);

    const beforeEmptyFolder = await database.rows('LinkedChildren', { where: { ParentId: firstNativeId } });
    await playlists.add(first.Id, [ids.folder], { user: owner });
    assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: firstNativeId } }), beforeEmptyFolder);

    await playlists.update(first.Id, { user: owner, name: 'Edited Mix', ids: [ids.second, ids.first, ids.second],
      users: [{ UserId: editor.Id, CanEdit: false }, { UserId: editor.Id, CanEdit: true },
        { UserId: ids.viewer, CanEdit: false }], isPublic: true });
    let edited = (await database.rows('BaseItems', { where: { Id: firstNativeId }, limit: 1 }))[0];
    assert.equal(edited.Name, 'Edited Mix');
    assert.equal(edited.CleanName, 'edited mix');
    assert.equal(edited.Path, row.Path, 'Renaming a playlist does not rename its managed directory.');
    assert.deepEqual(normalizedPlaylistData(JSON.parse(edited.Data)), { OwnerUserId: idKey(owner.Id), OpenAccess: true,
      Shares: [{ UserId: idKey(editor.Id), CanEdit: false }, { UserId: idKey(editor.Id), CanEdit: true },
        { UserId: idKey(ids.viewer), CanEdit: false }], PlaylistMediaType: 'Video' });
    assert.deepEqual((await playlists.get(first.Id, { user: owner })).ItemIds,
      [idKey(ids.second), idKey(ids.first), idKey(ids.second)], 'Update preserves duplicate item order.');
    assert.deepEqual(normalizedShares(await playlists.getUsers(first.Id, { user: owner })), [
      { UserId: idKey(editor.Id), CanEdit: false }, { UserId: idKey(editor.Id), CanEdit: true },
      { UserId: idKey(ids.viewer), CanEdit: false }
    ]);
    assert.deepEqual(normalizedShare(await playlists.getUser(first.Id, ids.viewer, { user: owner })),
      { UserId: idKey(owner.Id), CanEdit: true }, 'The owner lookup returns the native calling-owner permission.');
    await assert.rejects(playlists.getUsers(first.Id, { user: editor }), error => error.status === 403);
    assert.deepEqual(normalizedShare(await playlists.getUser(first.Id, editor.Id, { user: editor })),
      { UserId: idKey(editor.Id), CanEdit: false }, 'The first duplicate share is returned.');

    await playlists.updateUser(first.Id, editor.Id, { user: owner, canEdit: null });
    assert.deepEqual(normalizedShares(await playlists.getUsers(first.Id, { user: owner })), [
      { UserId: idKey(editor.Id), CanEdit: true }, { UserId: idKey(ids.viewer), CanEdit: false },
      { UserId: idKey(editor.Id), CanEdit: false }
    ], 'Updating a share removes its first occurrence and appends the replacement.');
    await playlists.removeUser(first.Id, ids.viewer, { user: editor });
    assert.deepEqual(normalizedShares(await playlists.getUsers(first.Id, { user: owner })), [
      { UserId: idKey(editor.Id), CanEdit: true }, { UserId: idKey(editor.Id), CanEdit: false }
    ]);
    await assert.rejects(playlists.removeUser(first.Id, ids.viewer, { user: editor }), error => error.status === 404);

    await playlists.update(first.Id, { user: owner, name: null, ids: null, users: null, isPublic: null });
    assert.equal((await database.rows('BaseItems', { where: { Id: firstNativeId }, limit: 1 }))[0].Name, 'Edited Mix',
      'Null update members retain their current values.');
    await playlists.update(first.Id, { user: owner, ids: [] });
    assert.deepEqual((await playlists.get(first.Id, { user: owner })).ItemIds, [], 'An explicit empty Ids list clears the playlist.');
    let retainedUpdate, retainedUpdateOwner;
    const retainUpdate = event => { retainedUpdate = event.Item; retainedUpdateOwner = acquireNativeItemLinkOwner(event.Item); };
    library.once('ItemUpdated', retainUpdate);
    try {
    await playlists.update(first.Id, { user: owner, ids: [ids.second, ids.second] });
    const editedSidecar = await readFile(path.join(row.Path, 'playlist.xml'), 'utf8');
    assert.match(editedSidecar, /<LocalTitle>Edited Mix<\/LocalTitle>/u);
    assert.equal((editedSidecar.match(/<PlaylistItem>/gu) ?? []).length, 2);
    assert.equal((editedSidecar.match(/<UserId>71000000-0000-0000-0000-000000000002<\/UserId>/gu) ?? []).length, 2);
    assert.equal(retainedUpdate.Id, firstNativeId);
    assert.equal(await linkedChildren.count(retainedUpdate.LinkedChildren), 2n, 'An event consumer retains the exact updated member branch after the playlist operation releases.');
    } finally {
      library.off('ItemUpdated', retainUpdate); retainedUpdateOwner?.release(); await linkedChildren.flushReleases();
    }

    const xmlPath = path.join(row.Path, 'playlist.xml');
    const originalXml = await readFile(xmlPath);
    await rm(xmlPath);
    await mkdir(xmlPath);
    await assert.rejects(playlists.update(first.Id, { user: owner, name: 'Must Roll Back' }), error => error.status === 409);
    edited = (await database.rows('BaseItems', { where: { Id: firstNativeId }, limit: 1 }))[0];
    assert.equal(edited.Name, 'Edited Mix', 'A sidecar failure rolls the repository edit back.');
    await rm(xmlPath, { recursive: true });
    await writeFile(xmlPath, originalXml);

    database.queryHook = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/INSERT INTO\s+[^\n]+\."AncestorIds"/u.test(text)) throw new Error('injected ancestor failure');
      return database.client.query(...args);
    };
    try {
      await assert.rejects(playlists.create({ name: 'Rollback', user: owner }), /injected ancestor failure/);
    } finally {
      database.queryHook = null;
    }
    await assert.rejects(access(path.join(dataPath, 'playlists', 'Rollback')), { code: 'ENOENT' });
    assert.equal((await database.rows('BaseItems')).some(entry => path.basename(entry.Path ?? '') === 'Rollback'), false);
    assert.equal(added.length, 4, 'A rolled-back create emits no event.');

    await database.client.query("CREATE FUNCTION playlist_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected base-item delete failure'; END $$");
    await database.client.query('CREATE TRIGGER playlist_delete_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION playlist_delete_failure()');
    await assert.rejects(playlists.delete(first.Id, { user: owner }), /injected base-item delete failure/);
    await database.client.query('DROP TRIGGER playlist_delete_failure ON "BaseItems"');
    await assert.rejects(access(row.Path), { code: 'ENOENT' }, 'Native SQL rollback does not restore earlier source deletion.');
    assert.equal((await database.rows('BaseItems', { where: { Id: firstNativeId } })).length, 1);
    assert.equal(removed.length, 0);

    await assert.rejects(playlists.delete(first.Id, { user: editor }), error => error.status === 401);
    await rm(collisionRow.Path, { recursive: true, force: true });
    await playlists.delete(collision.Id, { user: owner });
    assert.equal((await database.rows('BaseItems', { where: { Id: nativeGuid(collision.Id) } })).length, 0,
      'A missing managed directory does not strand its repository item.');
    await playlists.delete(first.Id, { user: owner });
    assert.equal((await database.rows('BaseItems', { where: { Id: firstNativeId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: ids.first } })).length, 1, 'Deleting a playlist never deletes media.');
    assert.equal((await database.rows('LinkedChildren', { where: { ParentId: firstNativeId } })).length, 0);
    await assert.rejects(access(row.Path), { code: 'ENOENT' });
    assert.equal(removed.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    try { await closeStateDeletion({ playlists, itemCreation, library, linkedChildren }); await store.close(); closed = true; }
    finally {
      if (!closed) await database.close();
      if (dialect === 'postgres') await dropPostgresSchemas(database);
      await rm(directory, { recursive: true, force: true });
    }
  }
});
