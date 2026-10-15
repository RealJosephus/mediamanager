import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeModel } from '../../src/database/model.js';
import { nativeTextCell } from '../../src/database/native-text.js';
import {
  assertPinnedNativeEnvelope,
  pinnedNativeSqliteSchemaFingerprint,
} from '../../src/database/native-envelope.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { canonicalNativeSqliteSchema } from '../../src/database/sqlite-schema.js';
import {
  assertPinnedJellyfinEnvelope,
  exportCurrentSqlite,
  pinnedNativeDataMigrationProductVersion,
  pinnedNativeSqliteMigrationHistory,
} from '../../src/migration/database-transfer.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { fixtureIds, seedAllTables } from '../database/fixtures.js';

const exchangeRow = (tableName, row) => {
  const columns = nativeModel.tables.find(table => table.name === tableName).columns;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value !== null && columns.find(column => column.name === key)?.type === 'TEXT' ? nativeTextCell(value) : value]));
};

const sourceContract = {
  mounts: [{ mountId: 'movies-main', identityRoot: 'Z:\\Media', accessRoot: '/vfs/movies', pathStyle: 'windows',
    caseSensitive: false, returnPolicy: 'required' }]
};
const targetContract = {
  mounts: [{ mountId: 'movies-main', identityRoot: '/srv/jellyfin/media', accessRoot: '/vfs/movies', pathStyle: 'posix',
    caseSensitive: true, returnPolicy: 'required' }]
};
const fixtureContract = {
  mounts: [{ ...sourceContract.mounts[0], identityRoot: 'Z:\\' }]
};
const nativeChannelId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const nativeRemoteImageId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function absent(filename) {
  try { await access(filename); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('repository-generated canonical SQLite schema matches the pinned fingerprint', () => {
  const canonical = canonicalNativeSqliteSchema();
  assert.equal(canonical.fingerprint, pinnedNativeSqliteSchemaFingerprint);
  assert.ok(canonical.ddl.some(sql => sql.startsWith('CREATE TABLE "__EFMigrationsHistory"')));
  assert.ok(canonical.ddl.some(sql => sql.startsWith('CREATE TABLE "__EFMigrationsLock"')));
});

test('canonical fresh SQLite history contains every pinned migration', () => {
  assert.deepEqual(pinnedNativeSqliteMigrationHistory, [
    ...nativeModel.migrations.map(MigrationId => ({
      MigrationId,
      ProductVersion: nativeModel.efProductVersion,
    })),
    ...nativeModel.dataMigrations.map(MigrationId => ({
      MigrationId,
      ProductVersion: pinnedNativeDataMigrationProductVersion,
    })),
  ].sort((left, right) => left.MigrationId.localeCompare(right.MigrationId, 'en')));
});

test('strict SQLite compatibility requires every pinned data migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-data-migration-history-'));
  const filename = path.join(directory, 'jellyfin.db');
  const created = new SqliteDatabase(filename, { create: true });
  created.close();
  const raw = new DatabaseSync(filename);
  try {
    raw.exec(canonicalNativeSqliteSchema().ddl.find(sql => sql.startsWith('CREATE TABLE "__EFMigrationsHistory"')));
    const insert = raw.prepare('INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES (?, ?)');
    for (const row of pinnedNativeSqliteMigrationHistory) insert.run(row.MigrationId, row.ProductVersion);
    raw.prepare('DELETE FROM "__EFMigrationsHistory" WHERE "MigrationId" = ?')
      .run(nativeModel.dataMigrations[0]);
  } finally { raw.close(); }
  try {
    assert.throws(() => new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true }),
      /Incomplete native EF migration history/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pinned SQLite compatibility accepts and preserves upgraded migration product versions', () => {
  const history = pinnedNativeSqliteMigrationHistory.map((row, index) => ({
    ...row,
    ProductVersion: index === 0 ? '3.1.3'
      : index === pinnedNativeSqliteMigrationHistory.length - 1 ? '12.0.0.0' : row.ProductVersion,
  }));
  const envelope = {
    ddl: ['CREATE TABLE "EnvelopeShape" ("Id" INTEGER)'],
    fingerprint: pinnedNativeSqliteSchemaFingerprint,
    history,
    sqliteSequence: [],
  };
  assert.deepEqual(assertPinnedNativeEnvelope(envelope).history, history);
  assert.throws(() => assertPinnedNativeEnvelope({
    ...envelope,
    history: history.slice(0, -1),
  }), /complete pinned Jellyfin migration history/u);
  assert.throws(() => assertPinnedNativeEnvelope({
    ...envelope,
    history: history.map((row, index) => index === 0
      ? { ...row, MigrationId: `${row.MigrationId}_unknown` } : row),
  }), /complete pinned Jellyfin migration history/u);
});

test('production SQLite export rejects a synthetic envelope unless the test-only bypass is explicit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-envelope-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'invalid.db');
  try {
    seedAllTables(source);
    await assert.rejects(exportCurrentSqlite(source, filename), /pinned Jellyfin schema fingerprint|complete pinned Jellyfin migration history/u);
    assert.equal(await absent(filename), true);
    await exportCurrentSqlite(source, filename, { testOnlyAllowSyntheticEnvelope: true });
    const returned = new SqliteDatabase(filename);
    returned.close();
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export without a target contract preserves source path spelling byte-for-byte', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-source-path-spelling-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  let returned;
  try {
    seedAllTables(source);
    const sourcePath = 'z:/MEDIA/Films/One.mkv';
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { Path: sourcePath });
    const result = await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    });
    returned = new SqliteDatabase(filename, { readOnly: true });
    assert.equal(returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0].Path, sourcePath);
    assert.equal(result.pathProjection.rewrittenPaths, 0);
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export retargets media paths without touching remote URLs or instance-state image paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-paths-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  let returned;
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Path: 'Z:\\Media\\Films\\One.mkv',
      Data: '{"AdditionalParts":["Z:\\\\Media\\\\Films\\\\One-part2.mkv"],"LocalAlternateVersions":["Z:\\\\Media\\\\Films\\\\One-4k.mkv"],"SubtitleFiles":["Z:\\\\Media\\\\Films\\\\One.en.srt"],"AudioFiles":["Z:\\\\Media\\\\Films\\\\One.commentary.mka"],"LyricFiles":["Z:\\\\Media\\\\Films\\\\One.lrc"],"PhysicalLocationsList":["Z:\\\\Media\\\\Films"],"LinkedAlternateVersions":[{"Path":"Z:\\\\Media\\\\Films\\\\One-linked.mkv","Type":"LinkedAlternateVersion"}],"ShortcutPath":"https://stream.invalid/One.m3u8","Counter":9007199254740993}'
    });
    const stream = source.rows('MediaStreamInfos')[0];
    source.update('MediaStreamInfos', { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }, {
      Path: 'Z:\\Media\\Films\\One.en.srt'
    });
    const itemImage = source.rows('BaseItemImageInfos')[0];
    source.update('BaseItemImageInfos', { Id: itemImage.Id }, { Path: 'Z:\\Media\\Films\\folder.jpg' });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: 'Z:\\Media\\Films\\chapter.jpg'
    });
    const image = source.rows('ImageInfos')[0];
    source.update('ImageInfos', { Id: image.Id }, { Path: 'Z:\\Media\\Films\\user.jpg' });
    const result = await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: sourceContract,
      targetPortableMountContract: targetContract,
    });
    assert.deepEqual(result.portableMountContract, targetContract);
    assert.ok(result.pathProjection.rewrittenPaths >= 8);
    returned = new SqliteDatabase(filename);
    const item = returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0];
    assert.equal(item.Path, '/srv/jellyfin/media/Films/One.mkv');
    assert.match(item.Data, /9007199254740993/u, 'unrelated lossless JSON number must remain byte-stable');
    const data = JSON.parse(item.Data);
    assert.deepEqual(data.AdditionalParts, ['/srv/jellyfin/media/Films/One-part2.mkv']);
    assert.deepEqual(data.LocalAlternateVersions, ['/srv/jellyfin/media/Films/One-4k.mkv']);
    assert.deepEqual(data.SubtitleFiles, ['/srv/jellyfin/media/Films/One.en.srt']);
    assert.deepEqual(data.AudioFiles, ['/srv/jellyfin/media/Films/One.commentary.mka']);
    assert.deepEqual(data.LyricFiles, ['/srv/jellyfin/media/Films/One.lrc']);
    assert.deepEqual(data.PhysicalLocationsList, ['/srv/jellyfin/media/Films']);
    assert.equal(data.LinkedAlternateVersions[0].Path, '/srv/jellyfin/media/Films/One-linked.mkv');
    assert.equal(data.ShortcutPath, 'https://stream.invalid/One.m3u8');
    assert.equal(returned.rows('MediaStreamInfos', { where: { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex } })[0].Path,
      '/srv/jellyfin/media/Films/One.en.srt');
    assert.equal(returned.rows('BaseItemImageInfos', { where: { Id: itemImage.Id } })[0].Path,
      '/srv/jellyfin/media/Films/folder.jpg');
    assert.equal(returned.rows('Chapters', { where: { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex } })[0].ImagePath,
      'Z:\\Media\\Films\\chapter.jpg');
    assert.equal(returned.rows('ImageInfos', { where: { Id: image.Id } })[0].Path,
      'Z:\\Media\\Films\\user.jpg');
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export preserves native internal repository paths and HTTP image/channel paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-native-paths-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  let returned;
  try {
    seedAllTables(source);
    const channelPath = 'https://channels.example.invalid/live/channel.m3u8';
    const internalImagePath = '%MetadataPath%\\library\\aa\\poster.jpg';
    const remoteImagePath = 'https://image.tmdb.org/t/p/original/poster.jpg';
    const internalStreamPath = '%MetadataPath%\\subtitles\\channel.en.srt';
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { ChannelId: nativeChannelId, Path: channelPath });
    const itemImage = source.rows('BaseItemImageInfos')[0];
    source.update('BaseItemImageInfos', { Id: itemImage.Id }, { Path: internalImagePath });
    source.insert('BaseItemImageInfos', { ...itemImage, Id: nativeRemoteImageId, Path: remoteImagePath });
    const stream = source.rows('MediaStreamInfos')[0];
    source.update('MediaStreamInfos', { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }, {
      Path: internalStreamPath
    });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: 'Z:\\Media\\chapter.jpg'
    });
    const profileImage = source.rows('ImageInfos')[0];
    source.update('ImageInfos', { Id: profileImage.Id }, { Path: 'Z:\\Media\\user.jpg' });

    await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    });
    returned = new SqliteDatabase(filename);
    assert.equal(returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0].Path, channelPath);
    assert.equal(returned.rows('BaseItemImageInfos', { where: { Id: itemImage.Id } })[0].Path, internalImagePath);
    assert.equal(returned.rows('BaseItemImageInfos', { where: { Id: nativeRemoteImageId } })[0].Path, remoteImagePath);
    assert.equal(returned.rows('MediaStreamInfos', {
      where: { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }
    })[0].Path, internalStreamPath);
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export keeps instance-state paths outside the portable media mount contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-instance-state-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  const instanceRoot = 'C:\\Jellyfin\\data\\root';
  const chapterPath = 'C:\\Jellyfin\\metadata\\chapters\\chapter.jpg';
  const profilePath = 'C:\\Jellyfin\\data\\users\\profile.png';
  let returned;
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
      Path: instanceRoot,
      Data: null,
    });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: chapterPath,
    });
    const profile = source.rows('ImageInfos')[0];
    source.update('ImageInfos', { Id: profile.Id }, { Path: profilePath });
    const itemImage = source.rows('BaseItemImageInfos')[0];
    source.update('BaseItemImageInfos', { Id: itemImage.Id }, {
      Path: 'C:\\Jellyfin\\metadata\\library\\poster.jpg',
    });
    const stream = source.rows('MediaStreamInfos')[0];
    source.update('MediaStreamInfos', { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }, {
      Path: 'C:\\Jellyfin\\metadata\\subtitles\\internal.srt',
    });
    const result = await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: sourceContract,
      targetPortableMountContract: targetContract,
    });
    assert.deepEqual(result.portableMountContract.mounts.map(({ mountId }) => mountId), ['movies-main']);
    returned = new SqliteDatabase(filename, { readOnly: true });
    assert.equal(returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0].Path, instanceRoot);
    assert.equal(returned.rows('Chapters', {
      where: { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }
    })[0].ImagePath, chapterPath);
    assert.equal(returned.rows('ImageInfos', { where: { Id: profile.Id } })[0].Path, profilePath);
    assert.equal(returned.rows('BaseItemImageInfos', { where: { Id: itemImage.Id } })[0].Path,
      'C:\\Jellyfin\\metadata\\library\\poster.jpg');
    assert.equal(returned.rows('MediaStreamInfos', {
      where: { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }
    })[0].Path, 'C:\\Jellyfin\\metadata\\subtitles\\internal.srt');
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export preserves malformed opaque BaseItems.Data byte-for-byte', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-opaque-data-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  const opaqueData = '{"Counter":9007199254740993,"legacy":not-json\\u0000';
  let returned;
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { Data: opaqueData });
    await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    });
    returned = new SqliteDatabase(filename, { readOnly: true });
    assert.equal(returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0].Data, opaqueData);
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite import and export path audit preserves native null BaseItems.Data path collections', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-null-paths-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  const data = '{"AdditionalParts":null,"AudioFiles":null,"LocalAlternateVersions":null,"LyricFiles":null,"PhysicalLocationsList":null,"SubtitleFiles":null,"LinkedAlternateVersions":null,"Counter":9007199254740993}';
  let returned;
  try {
    const audit = createSqliteExportPathProjector({ sourceContract: fixtureContract });
    assert.equal(audit.projectRow('BaseItems', exchangeRow('BaseItems', { Path: 'Z:\\Media\\One.mkv', ChannelId: null, Data: data })).Data.string(), data);
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { Data: data });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: 'Z:\\Media\\chapter.jpg',
    });
    await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    });
    returned = new SqliteDatabase(filename);
    assert.equal(returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0].Data, data);
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export audits and retargets every native compound image path candidate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-compound-image-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  let returned;
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { Path: 'Z:\\Media\\Films\\One.mkv' });
    const image = source.rows('BaseItemImageInfos')[0];
    source.update('BaseItemImageInfos', { Id: image.Id }, {
      Path: 'https://images.invalid/poster.jpg|Z:\\Media\\Films\\poster.jpg',
    });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: 'Z:\\Media\\Films\\chapter.jpg',
    });
    const profileImage = source.rows('ImageInfos')[0];
    source.update('ImageInfos', { Id: profileImage.Id }, { Path: 'Z:\\Media\\Films\\user.jpg' });
    const stream = source.rows('MediaStreamInfos')[0];
    source.update('MediaStreamInfos', { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }, {
      Path: 'Z:\\Media\\Films\\One.en.srt',
    });
    await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: sourceContract,
      targetPortableMountContract: targetContract,
    });
    returned = new SqliteDatabase(filename);
    assert.equal(returned.rows('BaseItemImageInfos', { where: { Id: image.Id } })[0].Path,
      'https://images.invalid/poster.jpg|/srv/jellyfin/media/Films/poster.jpg');
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const [name, compoundPath, message] of [
  ['storage URL', 'https://images.invalid/poster.jpg|webdav://user:secret@storage.invalid/poster.jpg', /storage protocol URL/u],
  ['credentialed HTTP URL', 'https://images.invalid/poster.jpg|https://user:secret@storage.invalid/poster.jpg', /storage protocol URL/u],
  ['VFS path', 'https://images.invalid/poster.jpg|/vfs/movies/poster.jpg', /VFS access path/u],
]) test(`SQLite export rejects a hidden ${name} in a compound image path`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-compound-image-leak-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  try {
    seedAllTables(source);
    const image = source.rows('BaseItemImageInfos')[0];
    source.update('BaseItemImageInfos', { Id: image.Id }, { Path: compoundPath });
    await assert.rejects(exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    }), message);
    assert.equal(await absent(filename), true);
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const [name, leakedPath, message] of [
  ['storage protocol URL', 'https://alist.invalid/dav/Films/One.mkv', /storage protocol URL/u],
  ['protocol-like path', 'custom:opaque-media-identity', /storage protocol URL/u],
  ['VFS access path', '/vfs/movies/Films/One.mkv', /VFS access path/u],
]) test(`SQLite export rejects a ${name} in Jellyfin media Path`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-leak-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Path: leakedPath,
      ChannelId: '00000000-0000-0000-0000-000000000000',
    });
    await assert.rejects(exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    }), message);
    assert.equal(await absent(filename), true);
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export rejects storage protocol URLs embedded in native BaseItems.Data paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-data-leak-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Data: '{"SubtitleFiles":["webdav://backend.invalid/One.srt"]}'
    });
    await assert.rejects(exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    }), /storage protocol URL/u);
    assert.equal(await absent(filename), true);
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const [name, update] of [
  ['direct path', { Path: 'Y:\\Unmapped\\One.mkv' }],
  ['embedded path', { Data: '{"SubtitleFiles":["Y:\\\\Unmapped\\\\One.srt"]}' }],
  ['relative direct path', { Path: 'relative\\One.mkv' }],
  ['relative embedded path', { Data: '{"SubtitleFiles":["relative\\\\One.srt"]}' }],
]) test(`SQLite export rejects an unmatched ${name} outside every portable mount`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-unmapped-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, update);
    await assert.rejects(exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    }), /outside every portable mount/u);
    assert.equal(await absent(filename), true);
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite export preserves a Jellyfin-native FTP shortcut URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-shortcut-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  let returned;
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Data: '{"ShortcutPath":"ftp://stream.invalid/One.m3u8"}'
    });
    const chapter = source.rows('Chapters')[0];
    source.update('Chapters', { ItemId: chapter.ItemId, ChapterIndex: chapter.ChapterIndex }, {
      ImagePath: 'Z:\\Media\\Films\\chapter.jpg'
    });
    await exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    });
    returned = new SqliteDatabase(filename, { readOnly: true });
    const item = returned.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0];
    assert.equal(JSON.parse(item.Data).ShortcutPath, 'ftp://stream.invalid/One.m3u8');
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite exchange accepts every Jellyfin-native remote playback protocol', () => {
  const projector = createSqliteExportPathProjector({ sourceContract: fixtureContract });
  for (const value of [
    'ftp://stream.invalid/media.ts',
    'http://stream.invalid/media.m3u8',
    'https://stream.invalid/media.m3u8',
    'rtmp://stream.invalid/live',
    'rtp://239.0.0.1:5004',
    'rtsp://stream.invalid:554/media',
    'udp://239.0.0.1:1234',
  ]) {
    const data = JSON.stringify({ ShortcutPath: value });
    const row = exchangeRow('BaseItems', { Path: value, ChannelId: nativeChannelId, Data: data });
    assert.strictEqual(projector.projectRow('BaseItems', row), row);
  }
  const remoteImage = exchangeRow('BaseItemImageInfos', { Path: 'https://images.invalid/poster.jpg' });
  assert.strictEqual(projector.projectRow('BaseItemImageInfos', remoteImage), remoteImage);
  assert.throws(() => projector.projectRow('BaseItemImageInfos', exchangeRow('BaseItemImageInfos', {
    Path: 'ftp://images.invalid/poster.jpg',
  })), /storage protocol URL/u);
  assert.throws(() => projector.projectRow('BaseItemImageInfos', exchangeRow('BaseItemImageInfos', {
    Path: 'custom:opaque-image-identity',
  })), /storage protocol URL/u);
  assert.throws(() => projector.projectRow('MediaStreamInfos', exchangeRow('MediaStreamInfos', {
    Path: 'smb:server/share/subtitle.srt',
  })), /storage protocol URL/u);
  assert.throws(() => projector.projectRow('Chapters', exchangeRow('Chapters', {
    ImagePath: 'custom:opaque-chapter-image',
  })), /storage protocol URL/u);
  assert.strictEqual(projector.projectRow('Chapters', exchangeRow('Chapters', {
    ImagePath: 'ImagePath: \u4e2d\u6587 / caf\u00e9',
  })).ImagePath.string(), 'ImagePath: \u4e2d\u6587 / caf\u00e9');
  assert.throws(() => projector.projectRow('BaseItems', exchangeRow('BaseItems', {
    Path: 'rtsp://stream.invalid/media',
    ChannelId: null,
    Data: null,
  })), /storage protocol URL/u);
});

test('SQLite export rejects credentials in a native remote shortcut URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-shortcut-userinfo-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'returned.db');
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, {
      Data: '{"ShortcutPath":"https://user:secret@stream.invalid/One.m3u8"}'
    });
    await assert.rejects(exportCurrentSqlite(source, filename, {
      testOnlyAllowSyntheticEnvelope: true,
      portableMountContract: fixtureContract,
    }), /storage protocol URL/u);
    assert.equal(await absent(filename), true);
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real pinned Jellyfin fixture exports as a strict directly-readable instance database', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-native-'));
  const source = new SqliteDatabase(process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE, { readOnly: true, requireMigrationHistory: true });
  let returned;
  try {
    await exportCurrentSqlite(source, path.join(directory, 'jellyfin.db'));
    returned = new SqliteDatabase(path.join(directory, 'jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    const canonical = canonicalNativeSqliteSchema();
    assert.equal(returned.schema.fingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.deepEqual(returned.schema.ddl, canonical.ddl);
    assert.deepEqual(returned.schema.history, source.schema.history);
    const integrity = returned.database.prepare('PRAGMA integrity_check').all();
    assert.equal(integrity.length, 1);
    assert.equal(integrity[0].integrity_check, 'ok');
    assert.deepEqual(returned.database.prepare('PRAGMA foreign_key_check').all(), []);
    for (const [changedIndex, historicalVersion] of [[0, '3.1.3'], [source.schema.history.length - 1, '12.0.0.0']]) {
      const upgradedHistory = source.schema.history.map((row, index) => ({
        ...row,
        ...(index === changedIndex ? { ProductVersion: historicalVersion } : {}),
      }));
      assert.deepEqual(assertPinnedJellyfinEnvelope({
        ...canonical,
        sqliteSequence: source.schema.sqliteSequence,
        history: upgradedHistory,
      }).history, upgradedHistory);
    }
    assert.throws(() => assertPinnedJellyfinEnvelope({
      ...canonical,
      sqliteSequence: source.schema.sqliteSequence,
      history: source.schema.history.slice(0, -1),
    }), /complete pinned Jellyfin migration history/u);
  } finally { returned?.close(); source.close(); await rm(directory, { recursive: true, force: true }); }
});
