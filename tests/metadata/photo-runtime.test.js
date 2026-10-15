import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createRuntime } from '../../src/runtime.js';
import { deserializeNativeItemData } from '../../src/library/native-item-data.js';
import { dateTicks } from '../../src/library/records.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const photoProvenance = new URL('./fixtures/photo-provider/provenance.json', import.meta.url);
const fixture = new URL('.', photoProvenance);
const Id = number => `ef200000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const removeFixtureDirectory = async directory => {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('photo-runtime-'));
  await rm(absolute, { recursive: true, force: false });
};

test('Photo runtime fixture binds the repository mapper distinction from live provider tags', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/photo-runtime/provenance.json', import.meta.url), 'utf8'));
  for (const entry of [...provenance.sources, ...provenance.files]) {
    assert.equal(createHash('sha256').update(await readFile(entry.filename)).digest('hex'), entry.sha256, entry.filename);
  }
  assert.equal(provenance.sources[0].sha256, provenance.sources[1].sha256);
  for (const entry of [...provenance.tagReaderAttribution.sources, ...provenance.tagReaderAttribution.files]) {
    assert.equal(createHash('sha256').update(await readFile(entry.filename)).digest('hex'), entry.sha256, entry.filename);
  }
  assert.deepEqual(await readFile(provenance.tagReaderAttribution.files[0].filename),
    await readFile(provenance.tagReaderAttribution.sources.find(entry => entry.filename.endsWith('/COPYING')).filename));
});

test('runtime joins embedded Photo refresh, stored DTO, oriented HTTP image and bounded PhotoAlbum cover copying', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photo-runtime-'));
  const database = await createPostgresTestDatabase(null, 'photo_runtime');
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\PhotoRuntime', accessRoot: '/media', style: 'windows', returnAccess: 'Isolated photo runtime originals.' });
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); await storage.close(); }
    finally { await dropPostgresTestDatabase(database); await removeFixtureDirectory(directory); }
  });
  const programDataPath = path.join(directory, 'program');
  runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'), vfs, identityMap,
    configuration: { IsStartupWizardCompleted: true, SaveLocalMetadata: true, UICulture: 'en-US' }, serverId: 'photo-runtime' });
  assert.equal(runtime.metadata.supports('Photo'), true); assert.equal(runtime.metadata.supports('PhotoAlbum'), true);
  const bytes = await readFile(new URL('assets/combined.jpg', fixture));
  await adapter.mkdir('/Album'); await adapter.write('/Album/combined.jpg', bytes, { modified: '2025-02-03T04:05:06.0000000Z' });
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(1), Type: 'MediaBrowser.Controller.Entities.PhotoAlbum',
    Name: 'Physical album', SortName: 'album', Path: 'Z:\\PhotoRuntime\\Album', IsFolder: true, DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(2), ParentId: Id(1), Type: 'MediaBrowser.Controller.Entities.Photo',
    Name: 'Stored photo', SortName: 'photo', Path: 'Z:\\PhotoRuntime\\Album\\combined.jpg', MediaType: 'Photo',
    DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
  await database.insert('AncestorIds', { ItemId: Id(2), ParentItemId: Id(1) });
  const refreshed = await runtime.metadata.refresh(Id(2), { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(refreshed.Failures, 0);
  assert.deepEqual(refreshed.Item.Tags, ['travel', ' travel ', '', 'travel']);
  const stored = (await database.rows('BaseItems', { where: { Id: Id(2) } }))[0];
  const data = deserializeNativeItemData(stored.Type, stored.Data);
  assert.equal(stored.Name, 'XMP title'); assert.equal(stored.Overview, 'XMP overview');
  assert.equal(stored.Width, 8); assert.equal(stored.Height, 6); assert.equal(stored.ProductionYear, 2024);
  assert.equal(dateTicks(stored.DateCreated), dateTicks('2024-03-02T14:04:05Z'));
  assert.equal(dateTicks(stored.PremiereDate), dateTicks('2024-03-02T22:04:05Z'));
  assert.deepEqual([data.CameraMake, data.CameraModel, data.Software, data.Orientation, data.IsoSpeedRating],
    ['XMP maker', 'XMP camera', 'XMP software', 'LeftBottom', 800]);
  assert.deepEqual([data.ExposureTime, data.FocalLength, data.Aperture, data.ShutterSpeed], [0.004, 35, 2.8, null]);
  assert.deepEqual([data.Latitude, data.Longitude, data.Altitude], [-25.035, -121.5654, -12.5]);
  const primary = (await database.rows('BaseItemImageInfos', { where: { ItemId: Id(2) } }))[0];
  assert.equal(primary.Path, 'Z:\\PhotoRuntime\\Album\\combined.jpg'); assert.equal(primary.Width, 8); assert.equal(primary.Height, 6);
  const key = await runtime.apiKeys.create('Photo runtime');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, headers = { Authorization: `MediaBrowser Token="${key.AccessToken}"` };
  const response = await fetch(`${origin}/Items?ids=${Id(2)}&fields=PrimaryImageAspectRatio,Tags,Genres&enableUserData=false`, { headers });
  assert.equal(response.status, 200); const dto = (await response.json()).Items[0];
  assert.equal(dto.Album, 'Physical album'); assert.equal(dto.AlbumId, Id(1).replaceAll('-', ''));
  assert.equal(dto.ImageOrientation, 'LeftBottom'); assert.equal(dto.PrimaryImageAspectRatio, 8 / 6);
  // BaseItemMapper stores the first OrdinalIgnoreCase occurrence, while the
  // provider's live array above retains its duplicate entries.
  assert.deepEqual(dto.Tags, ['travel', ' travel ', '']); assert.deepEqual(dto.Genres, []);
  const photoImage = await fetch(`${origin}/Items/${Id(2)}/Images/Primary?format=Png`, { headers });
  assert.equal(photoImage.status, 200);
  const rendered = await sharp(Buffer.from(await photoImage.arrayBuffer())).metadata();
  assert.deepEqual([rendered.width, rendered.height], [6, 8]);
  const cover = await runtime.metadata.refresh(Id(1), { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(cover.Failures, 0);
  const coverRow = (await database.rows('BaseItemImageInfos', { where: { ItemId: Id(1) } }))[0];
  assert.ok(coverRow.Path.startsWith(path.join(programDataPath, 'metadata', 'library')));
  assert.equal(path.basename(coverRow.Path), 'folder.jpg');
  const albumImage = await fetch(`${origin}/Items/${Id(1)}/Images/Primary`, { headers });
  assert.equal(albumImage.status, 200); assert.deepEqual(Buffer.from(await albumImage.arrayBuffer()), bytes);
  assert.deepEqual((await adapter.listPage('/Album')).entries.map(entry => entry.name), ['combined.jpg']);
  const original = await adapter.openRead('/Album/combined.jpg');
  try { const chunks = []; for await (const chunk of original.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), bytes); }
  finally { await original.close(); }
});

test('configured local storage keeps nested Photo originals distinct from metadata for refresh, cold DTO dimensions and album covers', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photo-runtime-configured-'));
  const database = await createPostgresTestDatabase(null, 'photo_configured');
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { await dropPostgresTestDatabase(database); await removeFixtureDirectory(directory); }
  });
  const programDataPath = path.join(directory, 'program');
  runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true, SaveLocalMetadata: true, UICulture: 'en-US' }, serverId: 'photo-configured' });
  const storage = runtime.storage, capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  assert.ok(storage.types().includes('local'));
  const definition = storage.configuration();
  for (const id of ['photo-media', 'photo-nested', 'photo-metadata']) definition.instances.push({ id, type: 'local',
    config: { root: path.join(directory, id), createRoot: true, writable: true } });
  await storage.configure(definition);
  const bind = (identityRoot, instanceId, purpose) => storage.bindPath({ identityRoot, instanceId, purpose,
    style: 'windows', caseSensitive: false, returnAccess: 'Retain isolated Photo identities.', capabilities });
  const mediaRoot = 'Z:\\ConfiguredPhotos', albumPath = mediaRoot + '\\Album', photoPath = albumPath + '\\combined.jpg';
  await bind(mediaRoot, 'photo-media', 'library');
  const access = storage.identityMap.resolve({ identityPath: photoPath, style: 'windows' });
  const parentBytes = await sharp({ create: { width: 11, height: 2, channels: 3, background: '#774422' } }).jpeg().toBuffer();
  await storage.vfs.mkdir(path.posix.dirname(access)); await storage.vfs.write(access, parentBytes);
  await bind(albumPath, 'photo-nested', 'library');
  await bind(mediaRoot, 'photo-metadata', 'metadata');
  const bytes = await readFile(new URL('assets/combined.jpg', fixture));
  const metadataBytes = await sharp({ create: { width: 5, height: 10, channels: 3, background: '#224477' } }).png().toBuffer();
  assert.equal(storage.vfs.resolve(access).mount.instanceId, 'photo-nested');
  await storage.vfs.write(access, bytes);
  await storage.fileSystem.mkdir(albumPath, { recursive: true });
  await storage.fileSystem.writeFile(photoPath, metadataBytes);
  assert.equal(storage.vfs.resolve(storage.metadataIdentityMap.resolve({ identityPath: photoPath, style: 'windows' })).mount.instanceId, 'photo-metadata');
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(11), Type: 'MediaBrowser.Controller.Entities.PhotoAlbum',
    Name: 'Configured album', SortName: 'album', Path: albumPath, IsFolder: true, DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(12), ParentId: Id(11), Type: 'MediaBrowser.Controller.Entities.Photo',
    Name: 'Configured photo', SortName: 'photo', Path: photoPath, MediaType: 'Photo', DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
  await database.insert('AncestorIds', { ItemId: Id(12), ParentItemId: Id(11) });
  const refreshed = await runtime.metadata.refresh(Id(12), { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(refreshed.Failures, 0);
  const stored = (await database.rows('BaseItems', { where: { Id: Id(12) } }))[0];
  assert.equal(stored.Name, 'XMP title'); assert.deepEqual([stored.Width, stored.Height], [8, 6]);
  assert.equal(deserializeNativeItemData(stored.Type, stored.Data).CameraMake, 'XMP maker');
  const primary = (await database.rows('BaseItemImageInfos', { where: { ItemId: Id(12) } }))[0];
  assert.equal(primary.Path, photoPath);
  await database.update('BaseItemImageInfos', { Id: primary.Id }, { Width: 0, Height: 0 });
  const coldRows = await database.rows('BaseItemImageInfos', { where: { ItemId: Id(12) } });
  const dto = await runtime.library.getItem(Id(12), { fields: 'PrimaryImageAspectRatio', enableImages: false });
  assert.equal(dto.PrimaryImageAspectRatio, 8 / 6);
  assert.equal(dto.Album, 'Configured album'); assert.equal(dto.ImageOrientation, 'LeftBottom');
  assert.deepEqual(await database.rows('BaseItemImageInfos', { where: { ItemId: Id(12) } }), coldRows);
  const covered = await runtime.metadata.refresh(Id(11), { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(covered.Failures, 0);
  const cover = (await database.rows('BaseItemImageInfos', { where: { ItemId: Id(11) } }))[0];
  assert.ok(cover.Path.startsWith(path.join(programDataPath, 'metadata', 'library')));
  assert.equal(path.basename(cover.Path), 'folder.jpg');
  assert.deepEqual(await runtime.fileSystem.readFile(cover.Path), bytes);
  assert.deepEqual(await readFile(path.join(directory, 'photo-nested', 'combined.jpg')), bytes);
  assert.deepEqual(await readFile(path.join(directory, 'photo-media', 'Album', 'combined.jpg')), parentBytes);
  assert.deepEqual(await readFile(path.join(directory, 'photo-metadata', 'Album', 'combined.jpg')), metadataBytes);
});

test('Photo remote Primary replacement clears canonical loaded hashes through publication and PostgreSQL persistence', async t => {
  const { createPhotoMetadataPlugin } = await import('../../src/metadata/photo-provider.js');
  const { publishNativeImageInfos } = await import('../../src/metadata/images.js');
  const edge = JSON.parse(await readFile(new URL('edges/native.json', fixture), 'utf8'));
  const expected = edge.results.find(sample => sample.source.startsWith('https:'));
  const database = await createPostgresTestDatabase(null, 'photo_remote_hash');
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
  runtime = await createRuntime({ database, configuration: { IsStartupWizardCompleted: true }, serverId: 'photo-remote-hash' });
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(21), Type: 'MediaBrowser.Controller.Entities.Photo',
    Name: 'Remote original', Path: expected.source, MediaType: 'Photo', Width: 4, Height: 3, Data: '{}' }));
  const provider = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() { assert.fail('Retained dimensions avoid decoding.'); } } }).providers[0];
  for (const shape of ['canonical loaded row', 'preceding custom mutation', 'new Primary']) await t.test(shape, async () => {
    await database.deleteWhere('BaseItemImageInfos', { ItemId: Id(21) });
    if (shape !== 'new Primary') await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
      Id: Id(22), ItemId: Id(21), ImageType: 0, Path: 'old-primary.jpg', Width: 40, Height: 30,
      Blurhash: Buffer.from('old-blurhash'), DateModified: '2000-01-01 00:00:00' }));
    const loaded = await runtime.images.load(Id(21));
    if (shape !== 'new Primary') assert.deepEqual(loaded.images[0].Blurhash, Buffer.from('old-blurhash'));
    if (shape === 'preceding custom mutation') loaded.images[0].BlurHash = 'custom-hash';
    const update = await provider.fetch(loaded.item, { images: loaded.images, imageAssets: {
      async stat() { assert.fail('Remote registration skips stat.'); }, async read() { assert.fail('Unsupported extension skips tag reads.'); } } });
    assert.equal(update, expected.update); assert.equal(loaded.images[0].Blurhash, null);
    if (shape === 'preceding custom mutation') assert.equal(loaded.images[0].BlurHash, null);
    publishNativeImageInfos(loaded.item, loaded.images);
    assert.equal(loaded.item.ImageInfos[0].BlurHash, expected.images[0].BlurHash);
    await runtime.images.persist(loaded);
    const stored = (await database.rows('BaseItemImageInfos', { where: { ItemId: Id(21) } }))[0];
    assert.equal(stored.Path, expected.source); assert.equal(stored.Blurhash, null);
    assert.deepEqual([stored.Width, stored.Height], [expected.images[0].Width, expected.images[0].Height]);
    assert.equal(dateTicks(stored.DateModified), dateTicks(expected.images[0].dateModified));
  });
});
