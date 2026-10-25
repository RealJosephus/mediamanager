import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createTestRuntime } from '../helpers/runtime.js';
import { dateTicks } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { captureCurrentComic, input as comicInput, recordCandidate } from './fixtures/book-comic-current/capture.js';
import { captureCurrentNative as captureCurrentOpf, assetBytes, manifest as opfManifest } from './fixtures/book-opf-current/capture.js';

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
  runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
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
  const original = await assetBytes('main', opfManifest.groups.main.assets.find(entry => entry.path === 'epub/rich-both-separators.epub'));
  const { native: opfNative } = await captureCurrentOpf();
  const native = opfNative.groups.main.epubResults.find(value => value.name === 'rich-both-separators');
  assert.equal(native.result.HasMetadata, true);
  assert.equal(native.hasCover, true);
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

  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`, headers = { Authorization: `MediaBrowser Token="${key.AccessToken}"` };
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

test('Book runtime persists the current native independent RAR cover streams and zero-size image rows', async t => {
  const { consumer } = await captureCurrentComic();
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
  runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
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
    await recordCandidate('runtime', name, { refreshed: { Failures: refreshed.Failures },
      sourceSha256: digest(source), image: { Path: image.Path, Width: image.Width, Height: image.Height,
        ImageType: image.ImageType, Blurhash: Buffer.from(image.Blurhash ?? '').toString('utf8') },
      saved: { bytes: bytes.length, sha256: digest(bytes) } });
    assert.equal(bytes.length, expected.selected.bytes); assert.equal(digest(bytes), expected.selected.sha256);
    assert.deepEqual(bytes, await readFile(expected.files[0].path));
    const handle = await storage.vfs.openRead(access);
    try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), source); }
    finally { await handle.close(); }
    assert.deepEqual(await readdir(path.join(programDataPath, 'cache', 'book-archives')), []);
  });
});

test('Comic language outcomes preserve the complete metadata commit or failure through PostgreSQL and HTTP', async t => {
  const { native } = await captureCurrentComic();
  const values = new Set(['qz', 'qzz', 'qzzz', 'qzzzz', 'qzzzzzzz', '123', 'qzz-Latn-XY', 'qz-419', 'en--US', 'ca-ES-valencia']);
  const names = new Set(['xml-language-notvalid', 'xml-language-123', 'json-language-extra-6e6f7476616c6964',
    ...[...values].flatMap(value => ['xml', 'json'].map(format => 'language-boundary-' + format + '-' + Buffer.from(value).toString('hex')))]);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-runtime-'));
  const database = await createPostgresTestDatabase(null, 'book_runtime_language');
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
  runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' }, serverId: 'book-runtime-language', onError() {} });
  const storage = runtime.storage, definition = storage.configuration();
  for (const name of ['language-parent', 'language-original', 'language-metadata']) definition.instances.push({ id: name, type: 'local',
    config: { root: path.join(directory, name), createRoot: true, writable: true } });
  await storage.configure(definition);
  const root = 'Z:\\RuntimeComicLanguages';
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  for (const [identityRoot, instanceId, purpose] of [[root, 'language-parent', 'library'],
    [root + '\\Originals', 'language-original', 'library'], [root, 'language-metadata', 'metadata']]) {
    await storage.bindPath({ identityRoot, instanceId, purpose, style: 'windows', caseSensitive: false,
      returnAccess: 'Independently mapped original Comic and metadata sidecars.', capabilities });
  }
  const key = await runtime.apiKeys.create('Comic language runtime');

  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`, headers = { Authorization: `MediaBrowser Token="${key.AccessToken}"` };
  const readOriginal = async access => {
    const handle = await storage.vfs.openRead(access);
    try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
    finally { await handle.close(); }
  };
  const samples = comicInput.metadataCases.filter(sample => names.has(sample.name));
  assert.equal(samples.length, names.size);
  for (const [index, sample] of samples.entries()) await t.test(sample.name, async () => {
    const expected = native.results.find(row => row.name === sample.name && row.provider === 'combined');
    const itemId = 'ee430000-0000-0000-0000-' + String(index + 1).padStart(12, '0');
    const itemPath = root + `\\book-${index}.cbz`, originalPath = root + `\\Originals\\book-${index}.cbz`;
    const originalAccess = storage.identityMap.resolve({ identityPath: originalPath, style: 'windows' });
    const parentAccess = storage.identityMap.resolve({ identityPath: itemPath, style: 'windows' });
    const source = await readFile(expected.source.path), parentDecoy = Buffer.from('Parent Comic decoy.'), metadataDecoy = Buffer.from('Metadata Comic decoy.');
    await storage.vfs.write(originalAccess, source); await storage.vfs.write(parentAccess, parentDecoy);
    await runtime.fileSystem.writeFile(itemPath, metadataDecoy);
    storage.identityMap.bind(itemId, originalAccess);
    const sidecar = native.assets.find(row => row.scope === sample.name && path.basename(row.path) === 'book.xml');
    const sidecarPath = root + `\\book-${index}.xml`;
    const sidecarBytes = sidecar ? await readFile(sidecar.path) : null;
    if (sidecarBytes) await runtime.fileSystem.writeFile(sidecarPath, sidecarBytes);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId, Type: 'MediaBrowser.Controller.Entities.Book',
      Name: 'Stored language name', SortName: 'stored language name', Overview: 'Stored language overview', Path: itemPath, MediaType: 'Book',
      DateLastRefreshed: '2025-01-01 00:00:00', Data: '{}' }));
    const refreshed = await runtime.metadata.refresh(itemId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: true });
    const stored = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
    const links = await database.rows('PeopleBaseItemMap', { where: { ItemId: itemId } });
    const people = links.length ? await database.rows('Peoples', { whereIn: { Id: links.map(row => row.PeopleId) } }) : [];
    const credits = links.sort((a, b) => a.ListOrder - b.ListOrder).map(link => ({
      Name: people.find(person => person.Id === link.PeopleId).Name,
      Type: people.find(person => person.Id === link.PeopleId).PersonType, Role: link.Role, SortOrder: link.SortOrder }));
    const response = await fetch(`${origin}/Items?ids=${itemId}&fields=Overview,Genres,Studios,Tags,People&enableUserData=false`, { headers });
    assert.equal(response.status, 200);
    const dto = (await response.json()).Items[0];
    const observed = { refreshed: { Failures: refreshed.Failures, failed: Boolean(refreshed.ErrorMessage) },
      stored: { Name: stored.Name, Overview: stored.Overview }, credits, dto,
      original: { beforeSha256: digest(source), afterSha256: digest(await readOriginal(originalAccess)) },
      parentDecoySha256: digest(await readOriginal(parentAccess)), metadataDecoySha256: digest(await runtime.fileSystem.readFile(itemPath)),
      sidecar: sidecarBytes ? { beforeSha256: digest(sidecarBytes), afterSha256: digest(await runtime.fileSystem.readFile(sidecarPath)) } : null,
      spool: await readdir(path.join(programDataPath, 'cache', 'book-archives')) };
    await recordCandidate('language-runtime', sample.name, observed);
    assert.equal(observed.original.afterSha256, observed.original.beforeSha256);
    assert.equal(observed.parentDecoySha256, digest(parentDecoy)); assert.equal(observed.metadataDecoySha256, digest(metadataDecoy));
    if (observed.sidecar) assert.equal(observed.sidecar.afterSha256, observed.sidecar.beforeSha256);
    assert.deepEqual(observed.spool, []);
    assert.equal(refreshed.Failures, 0);
    assert.equal(observed.refreshed.failed, Boolean(expected.error));
    const metadata = expected.result?.HasMetadata ? expected.result : null;
    assert.equal(stored.Name, metadata?.item.Name ?? 'Stored language name');
    assert.equal(stored.Overview, metadata?.item.Overview ?? 'Stored language overview');
    const expectedCredits = (metadata?.people ?? []).map(person => ({ Name: person.Name, Type: person.type,
      Role: person.Role ?? '', SortOrder: person.SortOrder ?? null }));
    assert.deepEqual(credits, expectedCredits);
    assert.equal(dto.Name, stored.Name); assert.equal(dto.Overview, stored.Overview);
    const expectedPeopleDto = expectedCredits.map(({ Name, Type, Role }) => ({ Name, Type, Role }));
    assert.deepEqual(dto.People.map(({ Name, Type, Role }) => ({ Name, Type, Role })), expectedPeopleDto);
    assert.deepEqual(dto.Genres, metadata?.item.Genres ?? []);
    assert.deepEqual(dto.Studios.map(studio => studio.Name), metadata?.item.Studios ?? []);
    assert.deepEqual(dto.Tags, metadata?.item.Tags ?? []);
  });
});
