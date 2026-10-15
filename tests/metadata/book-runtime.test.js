import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createRuntime } from '../../src/runtime.js';
import { dateTicks } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const provenance = new URL('./fixtures/book-opf-epub/provenance.json', import.meta.url);
const fixture = new URL('.', provenance);
const id = 'ee410000-0000-0000-0000-000000000001';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('Book runtime reads the explicitly mapped original EPUB and saves its metadata and exact cover independently', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-runtime-'));
  const database = await createPostgresTestDatabase(null, 'book_runtime');
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('book-runtime-'));
      await rm(directory, { recursive: true });
    }
  });
  const programDataPath = path.join(directory, 'program');
  const errors = [];
  runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' }, serverId: 'book-runtime', onError: error => errors.push(error) });
  const storage = runtime.storage, definition = storage.configuration();
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  for (const name of ['book-parent', 'book-original', 'book-metadata']) definition.instances.push({ id: name, type: 'local',
    config: { root: path.join(directory, name), createRoot: true, writable: true } });
  await storage.configure(definition);
  const bind = (identityRoot, instanceId, purpose) => storage.bindPath({ identityRoot, instanceId, purpose,
    style: 'windows', caseSensitive: false, returnAccess: 'Retain isolated original Book paths.', capabilities });
  const root = 'Z:\\RuntimeBooks', itemPath = root + '\\book.epub', originalPath = root + '\\Originals\\rich.epub';
  await bind(root, 'book-parent', 'library');
  await bind(root + '\\Originals', 'book-original', 'library');
  await bind(root, 'book-metadata', 'metadata');
  const originalAccess = storage.identityMap.resolve({ identityPath: originalPath, style: 'windows' });
  const parentAccess = storage.identityMap.resolve({ identityPath: itemPath, style: 'windows' });
  const original = await readFile(new URL('assets/epub/rich-with-cover.epub', fixture));
  const native = JSON.parse(await readFile(new URL('native.json', fixture))).epubResults.find(value => value.name === 'rich-with-cover');
  const parentDecoy = Buffer.from('Parent media decoy.');
  const metadataDecoy = Buffer.from('Independent metadata decoy.');
  await storage.vfs.write(originalAccess, original);
  await storage.vfs.write(parentAccess, parentDecoy);
  await runtime.fileSystem.writeFile(itemPath, metadataDecoy);
  storage.identityMap.bind(id, originalAccess);
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: 'MediaBrowser.Controller.Entities.Book',
    Name: 'Before refresh', SortName: 'before refresh', Path: itemPath, MediaType: 'Book',
    DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
  const refreshed = await runtime.metadata.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ReplaceAllMetadata: true });
  assert.equal(refreshed.Failures, 0, JSON.stringify(errors.map(error => error.message)));
  const stored = (await database.rows('BaseItems', { where: { Id: id } }))[0];
  assert.equal(stored.Name, ' Rich title ', JSON.stringify({ errors: errors.map(error => error.message), error: refreshed.ErrorMessage })); assert.equal(stored.Overview, 'Overview nested tail & value');
  assert.equal(stored.ForcedSortName, ' Sort title '); assert.equal(stored.SeriesName, ' Series ');
  assert.equal(stored.IndexNumber, 2); assert.equal(stored.CommunityRating, 4); assert.equal(stored.ProductionYear, 2024);
  assert.equal(dateTicks(stored.PremiereDate), BigInt(native.result.item.premiereTicks));
  const providers = await database.rows('BaseItemProviders', { where: { ItemId: id } });
  assert.deepEqual(Object.fromEntries(providers.map(value => [value.ProviderId, value.ProviderValue])), { Amazon: 'A1', GoogleBooks: 'g1', ISBN: '978-123' });
  const primary = (await database.rows('BaseItemImageInfos', { where: { ItemId: id } }))[0];
  assert.equal(primary.Width, 8); assert.equal(primary.Height, 6);
  assert.ok(primary.Path.startsWith(path.join(programDataPath, 'metadata', 'library')));
  assert.equal(path.extname(primary.Path), '.png');
  assert.equal(digest(await runtime.fileSystem.readFile(primary.Path)), native.coverSha);
  const key = await runtime.apiKeys.create('Book runtime');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, headers = { Authorization: `MediaBrowser Token="${key.AccessToken}"` };
  const response = await fetch(`${origin}/Items?ids=${id}&fields=Genres,PrimaryImageAspectRatio&enableUserData=false`, { headers });
  assert.equal(response.status, 200); const dto = (await response.json()).Items[0];
  assert.equal(dto.Name, stored.Name); assert.equal(dto.SeriesName, ' Series '); assert.equal(dto.PrimaryImageAspectRatio, 8 / 6);
  assert.deepEqual(dto.Genres, native.result.item.Genres);
  const image = await fetch(`${origin}/Items/${id}/Images/Primary`, { headers });
  assert.equal(image.status, 200); const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(digest(bytes), native.coverSha);
  const dimensions = await sharp(bytes).metadata(); assert.deepEqual([dimensions.width, dimensions.height], [8, 6]);
  const originalHandle = await storage.vfs.openRead(originalAccess);
  try { const chunks = []; for await (const chunk of originalHandle.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), original); }
  finally { await originalHandle.close(); }
  assert.deepEqual(await runtime.fileSystem.readFile(itemPath), metadataDecoy);
  const parentHandle = await storage.vfs.openRead(parentAccess);
  try { const chunks = []; for await (const chunk of parentHandle.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), parentDecoy); }
  finally { await parentHandle.close(); }
  assert.deepEqual(await readdir(path.join(programDataPath, 'cache', 'book-archives')), []);
});

test('Book runtime persists the actual native independent RAR cover streams and zero-size image rows', async t => {
  const consumer = JSON.parse(await readFile(new URL('./fixtures/book-comic/image-consumer/native.json', import.meta.url)));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-runtime-'));
  const database = await createPostgresTestDatabase(null, 'book_runtime_rar');
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('book-runtime-'));
      await rm(directory, { recursive: true });
    }
  });
  const programDataPath = path.join(directory, 'program');
  runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' }, serverId: 'book-runtime-rar', onError() {} });
  const storage = runtime.storage, definition = storage.configuration();
  definition.instances.push({ id: 'rar-original', type: 'local', config: { root: path.join(directory, 'original'), createRoot: true, writable: true } });
  await storage.configure(definition);
  await storage.bindPath({ identityRoot: 'Z:\\RuntimeRarBooks', instanceId: 'rar-original', purpose: 'library', style: 'windows',
    caseSensitive: false, returnAccess: 'Operation-owned RAR original inputs.', capabilities: { create: true, replace: true, mkdir: true } });
  const names = ['Rar5.solid.rar-internal', 'Rar.encrypted_filesOnly.rar-internal'];
  for (const [index, name] of names.entries()) await t.test(name, async () => {
    const expected = consumer.results.find(value => value.name === name);
    assert.ok(expected, name);
    assert.equal(expected.saveLocal, false); assert.equal(expected.refresh.Failures, 0);
    const itemId = 'ee420000-0000-0000-0000-' + String(index + 1).padStart(12, '0');
    const itemPath = `Z:\\RuntimeRarBooks\\book-${index}.cbr`;
    const access = storage.identityMap.resolve({ identityPath: itemPath, style: 'windows' });
    const source = await readFile(expected.actualSource);
    assert.equal(digest(source), expected.sourceSha256);
    await storage.vfs.write(access, source); storage.identityMap.bind(itemId, access);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId, Type: 'MediaBrowser.Controller.Entities.Book',
      Name: name, SortName: name.toLowerCase(), Path: itemPath, MediaType: 'Book',
      DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
    const refreshed = await runtime.metadata.refresh(itemId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh' });
    assert.equal(refreshed.Failures, expected.refresh.Failures);
    const rows = await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } });
    assert.equal(rows.length, expected.images.length);
    const [image] = rows, [nativeImage] = expected.images;
    assert.equal(image.ImageType, 0); assert.equal(path.extname(image.Path), '.jpg');
    assert.equal(image.Width, nativeImage.Width); assert.equal(image.Height, nativeImage.Height);
    assert.equal(Buffer.from(image.Blurhash ?? '').toString('utf8'), nativeImage.BlurHash);
    const bytes = await runtime.fileSystem.readFile(image.Path);
    assert.equal(bytes.length, expected.selected.bytes); assert.equal(digest(bytes), expected.selected.sha256);
    assert.deepEqual(bytes, await readFile(expected.files[0].path));
    const handle = await storage.vfs.openRead(access);
    try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), source); }
    finally { await handle.close(); }
    assert.deepEqual(await readdir(path.join(programDataPath, 'cache', 'book-archives')), []);
  });
});
