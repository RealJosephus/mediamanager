import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createPlaylistItemsPlugin } from '../../src/metadata/playlist-items.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const playlistId = '48500000-0000-0000-0000-000000000001', songId = '48500000-0000-0000-0000-000000000002';

test('playlist provider releases parsed SQL links when PostgreSQL rejects the next writer and remains usable', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-items-ownership-'));
  const files = path.join(root, 'files'), spoolRoot = path.join(files, 'spool'); await fs.mkdir(spoolRoot, { recursive: true });
  const playlistPath = path.join(files, 'mix.m3u'), songPath = path.join(files, 'song.mp3');
  const bytes = Buffer.from('#EXTM3U\n#EXTINF:3,First\nsong.mp3\n#EXTINF:3,Repeated\nsong.mp3\n');
  await fs.writeFile(playlistPath, bytes); await fs.writeFile(songPath, Buffer.from('The owned media path exists.'));
  const database = await createPostgresTestDatabase(t, 'playlist_owner');
  const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  const registry = new StorageRegistry(); registry.registerType('local', config => LocalAdapter.open(config));
  const adapter = await registry.createInstance('files', 'local', { root: files, writable: true });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/files', instanceId: 'files', capabilities: { create: true, replace: true, delete: true, mkdir: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: files, accessRoot: '/files',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated real playlist files.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  let sourceCloses = 0, writerCalls = 0, rejectedStatements = 0, backendFailure, result;
  const openRead = adapter.openRead.bind(adapter);
  adapter.openRead = async (...args) => {
    const source = await openRead(...args);
    if (args[0] !== '/mix.m3u') return source;
    return { ...source, async close() { await source.close(); sourceCloses++; } };
  };
  t.after(async () => {
    if (result) releaseNativeItemLinks(result.Item);
    await links.flushReleases(); await fileSystem.close(); await registry.close(); await links.close();
    assert.equal(path.dirname(files), root); await fs.rm(files, { recursive: true });
  });
  for (const row of [
    postgresTestRow('BaseItems', { Id: playlistId, Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'Stored playlist', Path: playlistPath, IsFolder: true, Data: '{}' }),
    postgresTestRow('BaseItems', { Id: songId, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: 'Stored song', Path: songPath, Data: '{}' }),
  ]) await database.insert('BaseItems', row);
  await database.insert('LinkedChildren', postgresTestRow('LinkedChildren', { ParentId: playlistId, ChildId: songId, ChildType: 0, SortOrder: 0 }));
  const before = await database.rows('LinkedChildren', { where: { ParentId: playlistId } });
  const createWriter = links.createWriter.bind(links);
  links.createWriter = options => {
    if (++writerCalls !== 2) return createWriter(options);
    // Keep the production writer, its lease and its actual checked-out PG
    // session. The database itself rejects the second CREATE TEMP TABLE.
    const query = options.session.client.query.bind(options.session.client);
    const client = { query(statement, ...args) {
      assert.match(statement, /^CREATE TEMP TABLE "mm_link_input_/u);
      rejectedStatements++;
      return query(statement.replace('"Ordinal" bigint', '"Ordinal" missing_playlist_owner_type'), ...args)
        .catch(error => { backendFailure = error; throw error; });
    } };
    const session = new Proxy(options.session, { get(target, key) { return key === 'client' ? client : Reflect.get(target, key, target); } });
    return createWriter({ ...options, session });
  };
  const provider = createPlaylistItemsPlugin({ fileSystem, linkedChildren: links, spoolRoot }).providers[0];
  const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist'); Object.assign(item, { Id: playlistId, Path: playlistPath });
  const context = { localRoot: files, localPath: playlistPath,
    playlistLibraryRoots: async () => [files],
    async playlistFileExists(filename) { try { return (await fileSystem.stat(filename)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    async findMetadataItemByPath(filename) { return (await database.rows('BaseItems', { where: { Path: filename }, limit: 1 }))[0] ?? null; },
  };
  await assert.rejects(provider.getMetadata(item, context), error => { assert.equal(error, backendFailure); assert.equal(error.code, '42704'); return true; });
  assert.equal(rejectedStatements, 1); assert.equal(writerCalls, 2); assert.equal(sourceCloses, 1);
  const counts = () => links.withSession(async session => {
    const result = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
      result[name] = Number((await session.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    return result;
  });
  const afterFailure = await counts(); assert.deepEqual(afterFailure, { sets: 0, rows: 0, pins: 0 });
  assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: playlistId } }), before);
  assert.deepEqual(await fs.readFile(playlistPath), bytes); assert.deepEqual(await fs.readdir(spoolRoot), []);
  result = await provider.getMetadata(item, context); assert.equal(result.HasMetadata, true);
  const recovered = await links.page(result.Item.LinkedChildren);
  assert.deepEqual(recovered.map(row => row.ItemId), [songId, songId]); assert.equal(sourceCloses, 2);
  releaseNativeItemLinks(result.Item); result = undefined; await links.flushReleases();
  assert.deepEqual(await counts(), afterFailure); assert.deepEqual(await fs.readdir(spoolRoot), []);
  assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: playlistId } }), before);
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ backendCode: backendFailure.code, rejectedStatements,
    writerCalls, sourceCloses, afterFailure, recoveredIds: recovered.map(row => row.ItemId), persistedLinksUnchanged: true, sourceBytes: bytes.toString('base64') }, null, 2) + '\n');
});

test('playlist provider releases actual SQL results when parsed relation, source close or final flush prevents delivery', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-items-cleanup-'));
  const reasons = [['error', new Error('The actual playlist reader failed to close.')], ['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
  const scenarios = reasons.flatMap(([name, reason]) => [false, true].map(primary => ({ name: `${primary ? 'resolve-and-' : ''}close-${name}`, reason, primary, kind: 'close' })))
    .concat([{ name: 'parsed-release', kind: 'release' }, { name: 'final-flush', kind: 'flush', reason: 0 }]);
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const files = path.join(root, scenario.name), spoolRoot = path.join(files, 'spool'); await fs.mkdir(spoolRoot, { recursive: true });
    const playlistPath = path.join(files, 'mix.m3u'), songPath = path.join(files, 'song.mp3');
    const bytes = Buffer.from('#EXTM3U\n#EXTINF:3,First\nsong.mp3\n#EXTINF:3,Repeated\nsong.mp3\n');
    await fs.writeFile(playlistPath, bytes); await fs.writeFile(songPath, 'Actual media path');
    const database = await createPostgresTestDatabase(t, 'playlist_cleanup');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const registry = new StorageRegistry(); registry.registerType('local', config => LocalAdapter.open(config));
    const adapter = await registry.createInstance('files', 'local', { root: files, writable: true });
    const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    vfs.mount({ path: '/files', instanceId: 'files', capabilities: { create: true, replace: true, delete: true, mkdir: true } });
    identityMap.addPrefix({ identityRoot: files, accessRoot: '/files', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual cleanup fixture files.' });
    const fileSystem = new StorageFileSystem({ vfs, identityMap });
    let selected = true, injected = false, sourceCloses = 0, backendFailure, result, observed;
    t.after(async () => {
      selected = false; if (result) releaseNativeItemLinks(result.Item);
      await links.flushReleases(); await fileSystem.close(); await registry.close(); await links.close();
      assert.equal(path.dirname(files), root); await fs.rm(files, { recursive: true });
    });
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: songId, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: 'Stored song', Path: songPath, Data: '{}' }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: playlistId, Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'Stored playlist', Path: playlistPath, Data: '{}' }));
    await database.insert('LinkedChildren', postgresTestRow('LinkedChildren', { ParentId: playlistId, ChildId: songId, ChildType: 0, SortOrder: 0 }));
    const before = await database.rows('LinkedChildren', { where: { ParentId: playlistId } });
    const openRead = adapter.openRead.bind(adapter);
    adapter.openRead = async (...args) => {
      const source = await openRead(...args);
      if (args[0] !== '/mix.m3u') return source;
      return { ...source, async close() {
        await source.close(); sourceCloses++;
        if (selected && scenario.kind === 'close') throw scenario.reason;
      } };
    };
    const release = links.release.bind(links);
    links.release = async (handle, options) => {
      if (!selected || scenario.kind !== 'release' || injected) return release(handle, options);
      const query = options.session.client.query.bind(options.session.client);
      const client = { query(statement, ...args) {
        assert.ok(statement.startsWith(`DELETE FROM ${links.sets}`));
        injected = true;
        return query(statement.replace('WHERE id=$1', 'WHERE missing_playlist_release_id=$1'), ...args)
          .catch(error => { backendFailure = error; throw error; });
      } };
      const session = new Proxy(options.session, { get(target, key) { return key === 'client' ? client : Reflect.get(target, key, target); } });
      return release(handle, { ...options, session });
    };
    if (scenario.kind === 'flush') {
      const stale = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId: playlistId }); await writer.append({ ItemId: songId, Type: 0 }); return writer.finish();
      });
      links.queueRelease(stale);
      const flush = links.flushReleases.bind(links);
      links.flushReleases = async (...args) => {
        await flush(...args);
        if (selected && !injected) { injected = true; throw scenario.reason; }
      };
    }
    const provider = createPlaylistItemsPlugin({ fileSystem, linkedChildren: links, spoolRoot }).providers[0];
    const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist'); Object.assign(item, { Id: playlistId, Path: playlistPath });
    const context = { localRoot: files, localPath: playlistPath, playlistLibraryRoots: async () => [files],
      playlistFileExists: async filename => (await fileSystem.stat(filename)).isFile(),
      async findMetadataItemByPath(filename) {
        if (selected && scenario.primary) {
          try { await database.client.query('SELECT missing_playlist_lookup_column FROM "BaseItems"'); }
          catch (error) { backendFailure = error; throw error; }
        }
        return (await database.rows('BaseItems', { where: { Path: filename }, limit: 1 }))[0] ?? null;
      },
    };
    const failed = await provider.getMetadata(item, context).then(value => { result = value; return { value }; }, error => ({ error }));
    assert.ok(Object.hasOwn(failed, 'error'), 'A cleanup failure prevents result delivery even when its reason is falsy.');
    observed = failed.error;
    if (scenario.primary) {
      assert.equal(backendFailure.code, '42703'); assert.equal(observed.cause, backendFailure);
      assert.equal(observed.code, backendFailure.code);
      assert.deepEqual(observed.errors, [backendFailure, scenario.reason]);
    } else if (scenario.kind === 'release') { assert.equal(backendFailure.code, '42703'); assert.equal(observed, backendFailure); }
    else assert.equal(observed, scenario.reason);
    const counts = async () => {
      const counts = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      return counts;
    };
    const afterFailure = await counts(); assert.deepEqual(afterFailure, { sets: 0, rows: 0, pins: 0 });
    assert.equal(sourceCloses, 1); assert.deepEqual(await fs.readFile(playlistPath), bytes); assert.deepEqual(await fs.readdir(spoolRoot), []);
    assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: playlistId } }), before);
    selected = false; result = await provider.getMetadata(item, context); assert.equal(result.HasMetadata, true);
    const recoveredIds = (await links.page(result.Item.LinkedChildren)).map(row => row.ItemId); assert.deepEqual(recoveredIds, [songId, songId]);
    releaseNativeItemLinks(result.Item); result = undefined; await links.flushReleases();
    assert.equal(sourceCloses, 2); assert.deepEqual(await counts(), afterFailure); assert.deepEqual(await fs.readdir(spoolRoot), []);
    await fs.writeFile(path.join(root, scenario.name + '.json'), JSON.stringify({ scenario: scenario.name, failure: errorObservation(observed),
      sourceCloses, afterFailure, recoveredIds, persistentLinksUnchanged: true, sourceBytes: bytes.toString('base64') }, null, 2) + '\n');
  });
});
