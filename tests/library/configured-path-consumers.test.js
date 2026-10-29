import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { ImageService } from '../../src/images/service.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { UnsafeItemDeletionService } from '../../src/library/unsafe-item-deletion-service.js';
import { CleanDatabasePostScanTask } from '../../src/library/clean-database-post-scan-task.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['postgres'];
const postgres = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000 };
const id = 'd9410000-0000-0000-0000-000000000001', imageId = 'd9410000-0000-0000-0000-000000000002';
const key = id.replaceAll('-', ''), stamp = '2026-10-25T00:00:00.0000000Z';
const itemRow = values => postgresTestRow('BaseItems', { MediaType: 'Unknown', UnratedType: 'Other',
  Tags: '', Studios: '', Genres: '', ProductionLocations: '', ...values });
const save = async (filename, text) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text); };
const missing = async filename => assert.rejects(stat(filename), { code: 'ENOENT' });

test('external cleanup follows active paths and keeps one target while media-source enumeration awaits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-path-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locations = ['first', 'second', 'third'].map(name => ({
    metadataPath: path.join(root, name, 'metadata'), dataPath: path.join(root, name, 'data'), trickplayPath: path.join(root, name, 'trickplay'),
  }));
  let active = locations[0];
  const errors = [], manager = new ExternalDataManager({ store: {}, fileSystem: testFileSystem,
    get metadataPath() { return active.metadataPath; }, get dataPath() { return active.dataPath; },
    get trickplayPath() { return active.trickplayPath; }, logger: { error: error => errors.push(error) } });
  for (const location of locations) for (const folder of [
    path.join(location.metadataPath, 'library', key.slice(0, 2), key),
    path.join(location.dataPath, 'attachments', id.slice(0, 2), id),
    path.join(location.dataPath, 'subtitles', id.slice(0, 2), id),
    path.join(location.trickplayPath, id.slice(0, 2), id),
  ]) await save(path.join(folder, 'data.bin'), 'kept until its configured cleanup');
  active = locations[1];
  const item = { Id: id, Type: 'Movie', Path: null };
  await manager.deleteInternalItemFiles(item, { loaded: { async getMediaSources() { active = locations[2]; return [{ Id: id }]; } } });
  for (const folder of [
    path.join(locations[1].metadataPath, 'library', key.slice(0, 2), key),
    path.join(locations[1].dataPath, 'attachments', id.slice(0, 2), id),
    path.join(locations[1].dataPath, 'subtitles', id.slice(0, 2), id),
    path.join(locations[1].trickplayPath, id.slice(0, 2), id),
  ]) await missing(folder);
  for (const location of [locations[0], locations[2]]) {
    assert.equal((await stat(path.join(location.metadataPath, 'library', key.slice(0, 2), key))).isDirectory(), true);
    assert.equal((await stat(path.join(location.dataPath, 'attachments', id.slice(0, 2), id))).isDirectory(), true);
  }
  await manager.deleteItemFiles(item);
  await missing(path.join(locations[2].dataPath, 'attachments', id.slice(0, 2), id));
  assert.equal((await stat(path.join(locations[0].dataPath, 'attachments', id.slice(0, 2), id))).isDirectory(), true);
  t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null }));
});

test('postgres: later image loads use the active metadata destination for actual image access', postgres, async t => {
  const fixture = await setupChildrenFixture(t), { database, store, library, stateRoot } = fixture;
  const first = path.join(stateRoot, 'first-metadata'), second = path.join(stateRoot, 'second-metadata');
  let metadataPath = first;
  const processor = new ImageProcessor({ fileSystem: testFileSystem });
  const service = new ImageService({ store, library, processor, fileSystem: testFileSystem, get metadataPath() { return metadataPath; } });
  t.after(async () => { await service.close(); await processor.close(); });
  await database.insert('BaseItems', itemRow({ Id: id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Image path owner', Path: null, Data: '{}' }));
  const oldImage = path.join(first, 'poster.png'), newImage = path.join(second, 'poster.png');
  await save(oldImage, 'old image'); await save(newImage, 'new image');
  await database.insertBatch('BaseItemImageInfos', [{ Id: imageId, ItemId: id, ImageType: 0, Path: oldImage,
    DateModified: stamp, Width: 0, Height: 0, Blurhash: null }]);
  const before = await service.load(id);
  assert.deepEqual(await before.imageAssets.read(before.images[0].Path), Buffer.from('old image'));
  metadataPath = second;
  await database.update('BaseItemImageInfos', { Id: imageId }, { Path: newImage });
  const after = await service.load(id);
  assert.equal(after.metadataPath, second);
  assert.deepEqual(await after.imageAssets.read(after.images[0].Path), Buffer.from('new image'));
  await after.imageAssets.write(path.join(after.metadataPath, 'saved.png'), Buffer.from('new saved image'));
  assert.deepEqual(await readFile(path.join(second, 'saved.png')), Buffer.from('new saved image'));
  await missing(path.join(first, 'saved.png'));
  await assert.rejects(after.imageAssets.read(oldImage), { code: 'unmapped-path' });
});

test('postgres: UnsafeFast deletes data and source files under the active metadata root', postgres, async t => {
  const fixture = await setupChildrenFixture(t), { database, store, library, stateRoot } = fixture;
  const first = path.join(stateRoot, 'first-metadata'), second = path.join(stateRoot, 'second-metadata');
  let metadataPath = first;
  const externalData = new ExternalDataManager({ store, fileSystem: testFileSystem, get metadataPath() { return metadataPath; } });
  const service = new UnsafeItemDeletionService({ store, library, itemCreation: library.itemCreation, externalData });
  const source = root => path.join(root, 'genres', 'Action');
  const internal = root => path.join(root, 'library', key.slice(0, 2), key);
  for (const root of [first, second]) {
    await save(path.join(source(root), 'poster.png'), 'source image');
    await save(path.join(internal(root), 'poster.png'), 'internal image');
  }
  metadataPath = second;
  await database.insert('BaseItems', itemRow({ Id: id, Type: 'MediaBrowser.Controller.Entities.Genre',
    Name: 'Action', Path: source(second), Data: '{}' }));
  await service.deleteQueryItems({ includeitemtypes: ['Genre'] }, { deleteSourceFiles: true });
  assert.deepEqual(await database.rows('BaseItems', { where: { Id: id } }), []);
  await missing(source(second)); await missing(internal(second));
  assert.deepEqual(await readFile(path.join(source(first), 'poster.png')), Buffer.from('source image'));
  assert.deepEqual(await readFile(path.join(internal(first), 'poster.png')), Buffer.from('internal image'));
});

test('postgres: database cleanup observes a current-root playlist without removing its persisted item', postgres, async t => {
  const fixture = await setupChildrenFixture(t), { database, store, library, stateRoot } = fixture;
  let metadataPath = path.join(stateRoot, 'first-metadata');
  const externalData = new ExternalDataManager({ store, fileSystem: testFileSystem, get metadataPath() { return metadataPath; } });
  const itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: library.itemCreation, externalData,
    updates: fixture.host.updates, linkedChildReferences: { async reroute() { return []; } } });
  const cleaner = new CleanDatabasePostScanTask({ store, library, itemCreation: library.itemCreation, itemDeletion, externalData });
  metadataPath = path.join(stateRoot, 'second-metadata');
  const playlist = path.join(metadataPath, 'playlists', 'current.m3u');
  await save(playlist, '#EXTM3U\n');
  await database.insert('BaseItems', itemRow({ Id: id, Type: 'MediaBrowser.Controller.Playlists.Playlist',
    Name: 'Current playlist', Path: playlist, Data: '{}' }));
  const progress = [];
  await cleaner.run({ reportProgress: value => progress.push(value) });
  assert.equal((await database.rows('BaseItems', { where: { Id: id } })).length, 1);
  assert.deepEqual(await readFile(playlist), Buffer.from('#EXTM3U\n'));
  assert.equal(progress.at(-1), 100);
});
