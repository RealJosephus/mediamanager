import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createRuntime } from '../../src/runtime.js';
import { projectItem } from '../../src/library/dto.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { ImageService } from '../../src/images/service.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const provenanceUrl = new URL('./fixtures/photo-dto/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expected = name => native.results.find(sample => sample.name === name);
const nativePhoto = 'MediaBrowser.Controller.Entities.Photo';
const nativeAlbum = 'MediaBrowser.Controller.Entities.PhotoAlbum';
const Id = number => `df100000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const fields = new Set(input.fields);
const wire = value => JSON.parse(stringifyNativeJson(Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)))));
const options = { serverId: 'photo-dto' };
const selected = { fields: new Set(), enableImages: false };
const photo = values => Object.assign(newNativeItemEntity(nativePhoto), { Id: Id(1) }, values);

test('Photo DTO fields and physical album ancestry match actual native serialization without optional fields', async t => {
  for (const sample of input.dtoCases) await t.test(sample.name, async () => {
    const item = photo({ ...sample.values, ParentId: sample.parentId, OwnerId: sample.ownerId });
    const parents = sample.parents.map(({ Type, ...parent }) => Object.assign(newNativeItemEntity(Type === 'PhotoAlbum' ? nativeAlbum : 'MediaBrowser.Controller.Entities.Folder'), parent));
    const state = { byId: new Map(parents.map(parent => [idKey(parent.Id), parent])) };
    assert.deepEqual(wire(await projectItem(item, state, null, selected, options)), expected(sample.name).wire);
  });
});

test('Photo primary aspect ratio matches native missing, remote, local, failed and orientation branches', async t => {
  for (const sample of input.aspectCases) await t.test(sample.name, async () => {
    const item = photo({ Width: sample.width, Height: sample.height, Orientation: sample.orientation });
    const images = sample.kind === 'none' ? [] : [{ ImageType: 0, Path: sample.kind === 'remote' ? 'HTTPodd:path' : 'Z:\\photos\\sample.jpg' }];
    const state = { byId: new Map(), dtoRelations: { imageRowsByItem: new Map([[idKey(item.Id), images]]) } };
    let calls = 0;
    const dto = await projectItem(item, state, null, { ...selected, fields: new Set(['primaryimageaspectratio']) }, {
      ...options, getImageDimensions: async () => {
        calls++;
        if (sample.kind === 'error') throw new Error('Controlled dimension failure.');
        return { Width: sample.imageWidth, Height: sample.imageHeight };
      }
    });
    assert.equal(dto.PrimaryImageAspectRatio ?? null, expected(sample.name).ratio);
    assert.equal(calls, expected(sample.name).calls);
  });
});

test('PostgreSQL and authenticated HTTP Photo DTOs preserve tags and nearest physical album without SQL writes', async t => {
  const database = await createPostgresTestDatabase(null, 'photo_dto');
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
  runtime = await createRuntime({ database, configuration: { IsStartupWizardCompleted: true }, serverId: 'photo-dto' });
  const key = await runtime.apiKeys.create('Photo DTO comparison');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const sample of input.dtoCases) await t.test(sample.name, async () => {
    for (const row of await database.rows('BaseItems')) await database.delete('BaseItems', { Id: row.Id });
    for (const parent of sample.parents) await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: parent.Id, Type: parent.Type === 'PhotoAlbum' ? nativeAlbum : 'MediaBrowser.Controller.Entities.Folder',
      Name: parent.Name, IsFolder: true, Data: '{}'
    }));
    for (const parent of sample.parents) if (sample.parents.some(value => value.Id === parent.ParentId)) {
      await database.update('BaseItems', { Id: parent.Id }, { ParentId: parent.ParentId });
    }
    // Native repository controls can return missing parents. The authoritative
    // PostgreSQL model rejects that edge; its DTO traversal is compared above.
    if (sample.parentId && !sample.parents.some(parent => parent.Id === sample.parentId)) {
      await assert.rejects(database.insert('BaseItems', postgresTestRow('BaseItems', {
        Id: Id(1), Type: nativePhoto, ParentId: sample.parentId, Data: '{}'
      })), error => error.code === '23503');
      return;
    }
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(1), Type: nativePhoto, Name: 'Stored photo',
      ParentId: sample.parentId, OwnerId: sample.ownerId, MediaType: 'Photo', Data: JSON.stringify(sample.values) }));
    const before = await database.rows('BaseItems');
    assert.deepEqual(wire(await runtime.library.getItem(Id(1), { fields: '', enableImages: false })), expected(sample.name).wire);
    const response = await fetch(`${origin}/Items?ids=${Id(1)}&fields=&enableImages=false&enableUserData=false`,
      { headers: { Authorization: `MediaBrowser Token="${key.AccessToken}"` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    // The ordinary Items query filters owned non-extra entities before DTOs.
    assert.equal(body.Items.length, sample.ownerId ? 0 : 1);
    if (!sample.ownerId) assert.deepEqual(wire(body.Items[0]), expected(sample.name).wire);
    assert.deepEqual(await database.rows('BaseItems'), before);
  });
});

test('Photo DTO local dimensions use mapped originals, ignore cached remote dimensions and retain SQL image rows', async t => {
  const database = await createPostgresTestDatabase(null, 'photo_size');
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const media = await storage.createInstance('media', 'memory', {}), metadata = await storage.createInstance('metadata', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  vfs.mount({ path: '/metadata', instanceId: 'metadata', capabilities: {} });
  const identityMap = new IdentityAccessMap(), metadataMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\Photos', accessRoot: '/media', style: 'windows', returnAccess: 'Isolated photo originals.' });
  metadataMap.addPrefix({ identityRoot: 'Z:\\Photos', accessRoot: '/metadata', style: 'windows', returnAccess: 'Deliberately distinct image metadata.' });
  const bytes = await sharp({ create: { width: 9, height: 6, channels: 3, background: '#224466' } }).png().toBuffer();
  await media.write('/sample.png', bytes);
  await metadata.write('/sample.png', await sharp({ create: { width: 5, height: 10, channels: 3, background: '#446622' } }).png().toBuffer());
  await media.write('/broken.png', Buffer.from('invalid static image'));
  let runtime, images;
  t.after(async () => {
    try { await images?.close(); await runtime?.close(); await storage.close(); }
    finally { await dropPostgresTestDatabase(database); }
  });
  runtime = await createRuntime({ database, vfs, identityMap, configuration: { IsStartupWizardCompleted: true }, serverId: 'photo-dto' });
  images = new ImageService({ store: runtime.store, library: runtime.library, vfs, identityMap: metadataMap,
    mediaIdentityMap: identityMap, processor: runtime.imageProcessor });
  const primary = { Id: randomUUID(), ItemId: Id(1), ImageType: 0, Path: 'Z:\\Photos\\sample.png', Width: 0, Height: 0 };
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: Id(1), Type: nativePhoto, Path: primary.Path,
    Name: 'Static photo', MediaType: 'Photo', Width: 40, Height: 20, Data: '{"Orientation":"RightTop"}' }));
  await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', primary));
  const before = await database.rows('BaseItemImageInfos');
  assert.deepEqual(await images.getImageDimensions(photo({ Path: primary.Path }), { ...primary }), { Width: 9, Height: 6 });
  const query = { fields: 'PrimaryImageAspectRatio', enableImages: false };
  assert.equal((await runtime.library.getItem(Id(1), query)).PrimaryImageAspectRatio, 1.5);
  const key = await runtime.apiKeys.create('Photo dimension comparison');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/Items?ids=${Id(1)}&fields=PrimaryImageAspectRatio&enableImages=false&enableUserData=false`,
    { headers: { Authorization: `MediaBrowser Token="${key.AccessToken}"` } });
  assert.equal(response.status, 200); assert.equal((await response.json()).Items[0].PrimaryImageAspectRatio, 1.5);
  assert.deepEqual(await database.rows('BaseItemImageInfos'), before);
  for (const [filename, expectedRatio] of [['HTTPodd:path', 0.5], ['Z:\\Photos\\missing.png', 0.5], ['Z:\\Photos\\broken.png', 0.5]]) {
    await database.update('BaseItemImageInfos', { Id: primary.Id }, { Path: filename, Width: 90, Height: filename.startsWith('HTTP') ? 60 : 0 });
    assert.equal((await runtime.library.getItem(Id(1), query)).PrimaryImageAspectRatio, expectedRatio);
  }
  await database.update('BaseItemImageInfos', { Id: primary.Id }, { Path: 'Z:\\Photos\\missing.png', Width: 9, Height: 6 });
  assert.equal((await runtime.library.getItem(Id(1), query)).PrimaryImageAspectRatio, 1.5);
  const original = await media.openRead('/sample.png');
  try {
    const chunks = []; for await (const chunk of original.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally { await original.close(); }
});

test('Photo DTO fixture binds exact native helper execution, serializer assemblies and designated source closure', async () => {
  const { createHash } = await import('node:crypto');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
  const bound = async entry => {
    const bytes = await readFile(entry.filename);
    assert.equal(hash(bytes), entry.sha256, entry.filename);
    return bytes;
  };
  for (const entry of provenance.files) assert.equal(hash(await readFile(new URL(entry.filename, root))), entry.sha256, entry.filename);
  for (const entry of [...provenance.sources, ...provenance.capturedSources, ...provenance.assemblies, ...provenance.serializationAssemblies]) await bound(entry);
  for (const source of provenance.sources) assert.equal(source.sha256,
    provenance.capturedSources.find(entry => entry.relativePath === source.relativePath)?.sha256, source.relativePath);
  const record = JSON.parse(await bound(provenance.record));
  const bindings = JSON.parse(await bound(provenance.recordingBindings));
  const sourceBuild = JSON.parse(await bound(provenance.sourceBuild));
  await bound(provenance.sourceClosure.manifest);
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
  assert.equal(sourceBuild.passed, true); assert.equal(sourceBuild.fullBuildInputClosure, true);
  assert.equal(sourceBuild.sourceAfter.contentDigest, provenance.sourceClosure.contentDigest);
  assert.equal(sourceBuild.sourceAfter.verifiedFiles, provenance.sourceClosure.verifiedFiles);
  assert.equal(sourceBuild.closureManifest.sha256, provenance.sourceClosure.manifest.sha256);
  assert.equal(record.jellyfinDll.sha256, sourceBuild.buildIdentity.nativeDll.sha256);
  assert.equal(bindings.sourceBuild.sha256, provenance.sourceBuild.sha256);
  assert.equal(bindings.input.sha256, native.inputSha256);
  assert.equal(native.inputSha256, hash(await readFile(new URL('input.json', root))));
  assert.equal(record.sourceFilesSha256, provenance.sourceFilesSha256);
  for (const entry of record.sourceFiles) {
    const name = entry.filename.replaceAll(String.fromCharCode(92), '/').split('/').at(-1);
    assert.equal(entry.sha256, provenance.files.find(file => file.filename ===
      (name === 'Directory.Build.props' ? '../../../Directory.Build.props' : name))?.sha256, name);
  }
  assert.equal(record.outputs.find(entry => entry.filename.replaceAll(String.fromCharCode(92), '/').endsWith('/native.json'))?.sha256,
    provenance.files.find(entry => entry.filename === 'native.json').sha256);
  assert.deepEqual(native.assemblies.map(entry => [entry.name, entry.sha256]), provenance.assemblies.map(entry => [entry.name, entry.sha256]));
  assert.deepEqual(native.results.map(entry => entry.name), [...input.dtoCases, ...input.aspectCases].map(entry => entry.name));
  assert.equal(input.dtoCases.length, 19); assert.equal(input.aspectCases.length, 200);
});

