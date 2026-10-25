import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testFileSystem } from '../storage/plugin-files.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { decodeNativeTextBytes } from '../../src/database/native-text.js';
import { createPhotoAlbumImagePlugin } from '../../src/metadata/photo-album-provider.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { persistImageMetadata } from '../../src/metadata/persistence.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { ImageService } from '../../src/images/service.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { MIN_DATE, mapRecord } from '../../src/library/records.js';
import { cases, profile, captureCurrentNative, recordCandidate } from './fixtures/photo-album-cover-current/capture.js';

let native, nativeCapture;
before(async () => {
  nativeCapture = await captureCurrentNative();
  native = nativeCapture.native;
}, { timeout: 720000 });
const png = await readFile(new URL('../images/fixtures/http/poster.png', import.meta.url));
const jpeg = await readFile(new URL('../images/fixtures/http/backdrop.jpg', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failureValue = error => error == null || typeof error !== 'object' ? error : Array.isArray(error) ? error.map(failureValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error
    ? ['message', 'name', 'code', 'status', 'statusCode', 'stack', 'cause', 'errors'] : [])])].map(key => [key, failureValue(error[key])]));
const albumId = 'cd810000-0000-0000-0000-000000000001';
const stamp = '2026-10-01T00:00:00.0000000Z';
const sourceRoot = 'Z:\\PhotoAlbumSources';
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);

async function fixture(t, sample, { independentBytes = false, mediaBindingOnly = false } = {}) {
  const schema = 'album_cover_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true, max: 1 });
  const store = new DomainStore(database), directory = await mkdtemp(path.join(os.tmpdir(), 'mm-photo-album-'));
  const metadataPath = path.join(directory, 'metadata'), tempPath = path.join(directory, 'temp');
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const metadataImages = new MetadataImages({ processor: new ImageProcessor({ fileSystem: testFileSystem }) });
  let readOpens = 0, readCloses = 0;
  t.after(async () => {
    await metadataImages.close(); await storage.close();
    await database.client.query(`DROP SCHEMA ${q(schema)} CASCADE`); await database.client.query(`DROP SCHEMA ${q(schema + '__mm')} CASCADE`); await store.close();
    const absolute = path.resolve(directory), prefix = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(prefix) && path.basename(absolute).startsWith('mm-photo-album-'));
    await rm(absolute, { recursive: true, force: false });
    assert.equal(readOpens, readCloses, 'every selected media read closes its VFS handle');
  });
  const media = await storage.createInstance('media', 'memory', {}), sidecars = await storage.createInstance('sidecars', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  for (const name of ['media', 'sidecars']) vfs.mount({ path: '/' + name, instanceId: name, capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap(), metadataIdentityMap = new IdentityAccessMap();
  if (!mediaBindingOnly) identityMap.addPrefix({ identityRoot: sourceRoot, accessRoot: '/media', style: 'windows', returnAccess: 'isolated photo media' });
  metadataIdentityMap.addPrefix({ identityRoot: sourceRoot, accessRoot: '/sidecars', style: 'windows', returnAccess: 'independent isolated metadata images' });
  for (const mount of ['media', 'sidecars']) for (const filename of ['source.png', 'source.PNG', 'source.jpg', 'source.opaque', 'source.tbn', 'source.txt', 'source.heic', 'source.tif', 'source.tga', 'source.jpe', 'extensionless']) {
    const picture = filename === 'source.jpg' || independentBytes && mount === 'sidecars' ? jpeg : png;
    await vfs.write('/' + mount + '/' + filename, picture, { overwrite: false, modified: stamp });
  }
  const nativeRoot = sample.root;
  const identity = value => typeof value === 'string' && value.startsWith(nativeRoot)
    ? path.win32.join(sourceRoot, path.relative(nativeRoot, value)) : value;
  const convert = (table, record) => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    let value = record[column.name];
    assert.notEqual(value, undefined, `${table}.${column.name} is bound by the actual native row snapshot`);
    if (column.name === 'Path') value = identity(value);
    if (column.type === 'BLOB' && value != null) value = Buffer.from(value, 'base64');
    return [column.name, value];
  }));
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, rows] of [['BaseItems', sample.rows], ['BaseItemImageInfos', sample.imageRows], ['AncestorIds', sample.ancestors]]) {
      for (const row of rows) await db.insert(table, convert(table, row));
    }
  });
  const item = { Id: albumId, Type: 'PhotoAlbum', Path: path.win32.join(sourceRoot, 'album'), Name: 'Album',
    IsFolder: true, IsFileProtocol: true, SupportsLocalMetadata: true };
  const ioFailures = [];
  const destinationFileSystem = new Proxy(testFileSystem, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args) => {
      const relative = typeof args[0] === 'string' ? path.relative(metadataPath, args[0]) : null;
      const destination = relative !== null && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      if (destination && (sample.name === 'save-failure' && key === 'writeFile'
        || sample.name === 'delete-old-failure' && key === 'unlink')) {
        const error = Object.assign(new Error(key === 'writeFile'
          ? 'Injected SaveImage destination failure' : 'Injected previous image deletion failure'), { code: 'EIO' });
        ioFailures.push({ operation: key, filename: args[0], error: failureValue(error) }); throw error;
      }
      return value.apply(target, args);
    };
  } });
  const assets = new MetadataImageAssets({ fileSystem: destinationFileSystem, vfs, identityMap: metadataIdentityMap, metadataPath });
  const values = [];
  if (sample.name.startsWith('internal-cover') || sample.name.startsWith('boundary-') || sample.name === 'delete-old-failure' || ['external-cover', 'remote-cover'].includes(sample.name)) {
    let Path = sample.name === 'remote-cover' ? 'https://images.invalid/existing.png'
      : sample.name === 'external-cover' ? path.join(directory, 'external.png') : path.join(internalImagePath(item, metadataPath), 'old.png');
    if (sample.name === 'boundary-forward-separators') Path = Path.replaceAll('\\', '/');
    if (sample.name === 'boundary-root-equal') Path = internalImagePath(item, metadataPath);
    if (sample.name === 'boundary-dot-segment') Path = internalImagePath(item, metadataPath) + path.sep + '..' + path.sep + 'sibling' + path.sep + 'old.png';
    const DateModified = sample.name.startsWith('boundary-') || ['internal-cover-changed', 'internal-cover-missing-min'].includes(sample.name) ? MIN_DATE : stamp;
    values.push({ Type: 'Primary', Path, DateModified, Width: 40, Height: 20, Blurhash: Buffer.from('old-hash') });
    if (!sample.name.includes('missing') && sample.name !== 'remote-cover') {
      await mkdir(path.dirname(Path), { recursive: true }); await writeFile(Path, png); await utimes(Path, new Date(stamp), new Date(stamp));
    }
  }
  const queries = [];
  const selectedStore = { run(operation, options) { return store.run(db => operation({ dialect: db.dialect, schemaName: db.schemaName,
    client: { async query(query) {
      const result = await db.client.query(query);
      queries.push({ rows: result.rows.length, fields: result.fields.map(field => field.name), ids: result.rows.map(row => decodeNativeTextBytes(row.Id)) });
      return result;
    } } }), options); } };
  const saves = [], save = metadataImages.saveRemote.bind(metadataImages);
  metadataImages.saveRemote = (loaded, images, image, options) => save(loaded, images, image, { ...options, download: async (...args) => {
    const result = await options.download(...args);
    saves.push({ mime: result.mimeType, type: image.Type, saveLocally: loaded.saveLocalMetadataEnabled,
      extension: path.extname(image.Url), sha256: hash(result.bytes) });
    return result;
  } });
  const provider = createPhotoAlbumImagePlugin({ store: selectedStore, fileSystem: testFileSystem, vfs, identityMap,
    metadataIdentityMap, metadataPath, tempPath, images: metadataImages, configuration: { ImageSavingConvention: 'Compatible' } }).providers[0];
  const cancelled = new Error('Injected cancellation');
  const signal = sample.name === 'cancelled' ? AbortSignal.abort(cancelled) : undefined;
  const live = { images: values, imageAssets: assets, signal };
  const openRead = media.openRead.bind(media);
  media.openRead = async (...args) => { const handle = await openRead(...args); readOpens++; let closed = false; return { ...handle, close: async () => {
    if (!closed) { closed = true; readCloses++; } await handle.close();
  } }; };
  const project = value => value == null ? null : value.replace(directory, '$STATE').replace(directory.replaceAll('\\', '/'), '$STATE').replaceAll('\\', '/');
  const files = async root => { try { return await Promise.all((await readdir(root)).toSorted().map(async name => {
    const filename = path.join(root, name), bytes = await readFile(filename); return { path: project(filename), bytes: bytes.length, sha256: hash(bytes) };
  })); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; } };
  return { database, store, item, assets, live, provider, queries, saves, directory, metadataPath, tempPath,
    identityMap, metadataIdentityMap, vfs, media, sidecars, metadataImages, project, files, ioFailures, readCounts: () => ({ readOpens, readCloses }) };
}

test('album fixture binds two current native provider, SQLite query and actual ImageSaver executions', () => {
  assert.equal(nativeCapture.report.independentNativeCapturesAgree, true);
  assert.equal(nativeCapture.report.captures.length, 2);
  assert.equal(nativeCapture.report.sourceBindings.length, profile.sourcePaths.length);
  assert.deepEqual(native.results.map(row => row.name), cases);
});

for (const name of cases) test(`postgres: photo album provider matches current native ${name}`, { skip: !enabled }, async t => {
  const sample = native.results.find(row => row.name === name);
  const f = await fixture(t, sample);
  let changed = null, changeError = null, update = null, errorType = null;
  const diagnostic = failureValue;
  try { changed = await f.provider.hasChanged(f.item, f.live); } catch (error) { changeError = diagnostic(error); }
  try { update = await f.provider.fetch(f.item, f.live); } catch (error) { errorType = diagnostic(error); }
  const images = await Promise.all(f.live.images.map(async image => ({ path: f.project(image.Path), type: image.Type,
    Width: image.Width ?? 0, Height: image.Height ?? 0, BlurHash: image.Blurhash == null ? null : Buffer.from(image.Blurhash).toString(),
    sha256: /^http/u.test(image.Path) ? null : await readFile(image.Path).then(hash, error => error.code === 'ENOENT' ? null : Promise.reject(error)) })));
  const internalFiles = await f.files(internalImagePath(f.item, f.metadataPath));
  const temporaryFiles = (await f.files(f.tempPath)).map(file => ({ extension: path.extname(file.path), bytes: file.bytes, sha256: file.sha256 }));
  const observed = { changed, changeFailed: Boolean(changeError), update, error: Boolean(errorType), images, internalFiles, temporaryFiles };
  await recordCandidate(name, { observation: observed, changeError, errorType, saves: f.saves, selections: f.queries, ioFailures: f.ioFailures });
  assert.deepEqual(observed, { changed: sample.changed, changeFailed: Boolean(sample.changeError), update: sample.update,
    error: Boolean(sample.errorType), images: sample.images, internalFiles: sample.internalFiles, temporaryFiles: sample.temporaryFiles });
  assert.deepEqual(f.saves, sample.saves);
  assert.deepEqual(f.queries.map(query => query.ids), sample.selected.map(selection => selection.ids));
  assert.ok(f.queries.every(query => query.rows <= 1), 'SQL selects at most one cover candidate');
});

test('postgres: photo album selects one row from 20,000 descendants without materializing children', { skip: !enabled }, async t => {
  const f = await fixture(t, native.results.find(row => row.name === 'leaf-before-folder'));
  const columns = table => tableDefinition(table).columns.filter(column => !column.generated).map(column => column.name);
  const baseColumns = columns('BaseItems'), imageColumns = columns('BaseItemImageInfos');
  const generatedText = expression => `convert_to(${expression},'UTF8')`;
  const itemId = generatedText("'cd820000-0000-0000-0000-' || lpad(value::text,12,'0')");
  const baseOverrides = { Id: itemId, Name: generatedText("'Stress ' || value"), SortName: generatedText("'stress-' || value") };
  await f.database.client.query(`INSERT INTO "BaseItems" (${baseColumns.map(q).join(',')})
    SELECT ${baseColumns.map(name => baseOverrides[name] ?? 'template.' + q(name)).join(',')}
    FROM "BaseItems" template CROSS JOIN generate_series(1,20000) value WHERE template."Id"=convert_to($1,'UTF8')`,
  [native.results[1].rows.find(row => row.Name === 'First').Id]);
  await f.database.client.query(`INSERT INTO "AncestorIds" ("ItemId","ParentItemId")
    SELECT convert_to('cd820000-0000-0000-0000-' || lpad(value::text,12,'0'),'UTF8'),convert_to($1,'UTF8') FROM generate_series(1,20000) value`, [albumId]);
  const imageOverrides = { Id: generatedText("'cd821000-0000-0000-0000-' || lpad(value::text,12,'0')"), ItemId: itemId };
  await f.database.client.query(`INSERT INTO "BaseItemImageInfos" (${imageColumns.map(q).join(',')})
    SELECT ${imageColumns.map(name => imageOverrides[name] ?? 'template.' + q(name)).join(',')}
    FROM "BaseItemImageInfos" template CROSS JOIN generate_series(1,20000) value WHERE template."Id"=convert_to($1,'UTF8')`,
  [native.results[1].imageRows[0].Id]);
  for (const table of ['BaseItems', 'BaseItemImageInfos', 'AncestorIds']) await f.database.client.query(`ANALYZE ${q(table)}`);
  const originalRows = f.database.rows.bind(f.database);
  f.database.rows = async (...args) => { assert.fail('cover selection cannot materialize item or image tables'); return originalRows(...args); };
  assert.equal(await f.provider.hasChanged(f.item, f.live), true);
  assert.equal(await f.provider.fetch(f.item, f.live), 5);
  assert.deepEqual(f.queries.map(query => query.rows), [1, 1]);
});

async function imageHttp(t, f) {
  const library = { options: { fileSystem: testFileSystem, configuration: {} }, async getItemRecord(id) {
    const row = await f.store.run(async db => (await db.rows('BaseItems', { where: { Id: id } }))[0]); return mapRecord(row);
  } };
  const service = new ImageService({ store: f.store, library, fileSystem: testFileSystem, vfs: f.vfs,
    identityMap: f.metadataIdentityMap, mediaIdentityMap: f.identityMap, metadataPath: f.metadataPath,
    processor: new ImageProcessor({ fileSystem: testFileSystem }), metadataImages: f.metadataImages });
  const server = createServer(async (request, response) => {
    try { const result = await service.item({ itemId: albumId, imageType: 'Primary' }, { auth: {}, query: new URLSearchParams() }); await result.send(request, response); }
    catch (error) { response.statusCode = error.status ?? 500; response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/album-primary', { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) assert.fail(`Image HTTP returned ${response.status}: ${await response.text()}`);
  return { mime: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) };
}

test('postgres: album copy uses independent media and metadata mappings, commits image rows and serves original HTTP bytes', { skip: !enabled }, async t => {
  const f = await fixture(t, native.results.find(row => row.name === 'leaf-before-folder'), { independentBytes: true });
  assert.equal(await f.provider.fetch(f.item, f.live), 5);
  assert.deepEqual(await readFile(f.live.images[0].Path), png, 'the Photo primary source must use media mapping rather than sidecar mapping');
  await persistImageMetadata(f.store, { item: f.item, relationships: {} }, f.live.images);
  const rows = await f.database.rows('BaseItemImageInfos', { where: { ItemId: albumId } });
  assert.equal(rows.length, 1); assert.equal(rows[0].Path, f.live.images[0].Path);
  const response = await imageHttp(t, f);
  assert.equal(response.mime, 'image/png');
  assert.deepEqual(response.bytes, png);
});

test('postgres: album selected Photo respects its item binding without a media prefix', { skip: !enabled }, async t => {
  const sample = native.results.find(row => row.name === 'leaf-before-folder');
  const f = await fixture(t, sample, { independentBytes: true, mediaBindingOnly: true });
  f.identityMap.bind(sample.rows.find(row => row.Name === 'First').Id, '/media/source.png');
  assert.equal(await f.provider.fetch(f.item, f.live), 5);
  assert.deepEqual(await readFile(f.live.images[0].Path), png);
  assert.deepEqual(f.readCounts(), { readOpens: 1, readCloses: 1 });
});

for (const name of ['unknown-extension', 'jpeg-extension', 'tbn-extension', 'nonimage-extension', 'heic-extension', 'tif-extension', 'tga-extension', 'jpe-extension'])
  test(`postgres: actual image HTTP consumes album native ${name} bytes and MIME`, { skip: !enabled }, async t => {
    const sample = native.results.find(row => row.name === name), f = await fixture(t, sample);
    assert.equal(await f.provider.fetch(f.item, f.live), 5);
    await persistImageMetadata(f.store, { item: f.item }, f.live.images);
    const response = await imageHttp(t, f);
    assert.equal(response.mime, sample.saves[0].mime);
    assert.equal(hash(response.bytes), sample.images[0].sha256);
  });

test('postgres: album image insert failure retains the earlier image deletion and actual copied file', { skip: !enabled }, async t => {
  const f = await fixture(t, native.results.find(row => row.name === 'internal-cover-changed'));
  await persistImageMetadata(f.store, { item: f.item }, f.live.images);
  assert.equal(await f.provider.fetch(f.item, f.live), 5);
  await f.database.client.query("CREATE FUNCTION album_image_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'album image insert failed' USING ERRCODE='23514'; END $$");
  await f.database.client.query('CREATE TRIGGER album_image_failure BEFORE INSERT ON "BaseItemImageInfos" FOR EACH ROW EXECUTE FUNCTION album_image_failure()');
  await assert.rejects(persistImageMetadata(f.store, { item: f.item }, f.live.images), error => error.code === '23514');
  assert.deepEqual(await f.database.rows('BaseItemImageInfos', { where: { ItemId: albumId } }), []);
  assert.deepEqual(await readFile(f.live.images[0].Path), png);
  assert.deepEqual(await f.files(f.tempPath), []);
});

test('album storage paths are required only when an actual selected image needs copying', { skip: !enabled }, async t => {
  const f = await fixture(t, native.results.find(row => row.name === 'remote-first'));
  const provider = createPhotoAlbumImagePlugin({ store: f.store, images: f.metadataImages }).providers[0];
  assert.equal(await provider.fetch(f.item, { images: [] }), 1);
  await f.database.update('BaseItemImageInfos', { Id: native.results.find(row => row.name === 'remote-first').imageRows.find(row => row.Path.startsWith('https:')).Id }, { Path: path.win32.join(sourceRoot, 'source.png') });
  await assert.rejects(provider.fetch(f.item, { images: [] }), error => error.code === 'metadata-context-required');
});
