import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const provenanceUrl = new URL('./fixtures/book-photo-global/provenance.json', import.meta.url);
const fixture = new URL('.', provenanceUrl);
const matrix = JSON.parse(await readFile(new URL('input.json', fixture)));
const native = JSON.parse(await readFile(new URL('native.json', fixture)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value?.replaceAll('\\', '/');
const assetUrls = new Map([
  ['cover', new URL('./fixtures/book-photo-global/cover.png', import.meta.url)],
  ['plain-photo', new URL('./fixtures/book-photo-global/plain-photo.jpg', import.meta.url)],
  ['rich-photo', new URL('./fixtures/book-photo-global/rich-photo.jpg', import.meta.url)],
  ['oriented-photo', new URL('./fixtures/book-photo-global/oriented-photo.jpg', import.meta.url)],
  ['invalid-photo', new URL('./fixtures/book-photo-global/invalid-photo.jpg', import.meta.url)],
  ['epub-positive', new URL('./fixtures/book-photo-global/epub-positive.epub', import.meta.url)],
  ['epub-standard-slashes', new URL('./fixtures/book-photo-global/epub-standard-slashes.epub', import.meta.url)],
  ['epub-malformed', new URL('./fixtures/book-photo-global/epub-malformed.epub', import.meta.url)]
]);

function projectNative(record) {
  return record.results.map(sample => ({ name: sample.Name, steps: sample.observations.slice(1).map(observation => {
    const root = slash(sample.root), media = root + '/media', rows = observation.snapshot.sql.BaseItems;
    const normalize = value => typeof value !== 'string' ? null : slash(value).replace(media, '$MEDIA').replace(root + '/program', '$PROGRAM');
    const ids = new Map(rows.map(row => [row.Id.toLowerCase(), slash(row.Path) ?? '$NONPATH:' + row.Type + ':' + row.Name]));
    const items = rows.filter(row => slash(row.Path)?.startsWith(media + '/')).map(row => {
      const cold = observation.snapshot.cold.find(value => value.Id.toLowerCase() === row.Id.toLowerCase());
      return { path: normalize(row.Path), type: row.Type, name: row.Name, isFolder: !!row.IsFolder, mediaType: row.MediaType,
        parent: normalize(ids.get(String(row.ParentId).toLowerCase())), seriesName: row.SeriesName, index: row.IndexNumber,
        overview: row.Overview, genres: row.Genres ?? '', width: row.Width ?? 0, height: row.Height ?? 0,
        images: (cold?.imagePaths ?? []).map(image => ({ kind: image.Type, extension: path.extname(image.Path),
          location: slash(image.Path).startsWith(media + '/') ? 'local' : 'internal', width: image.Width,
          height: image.Height, blurHash: image.BlurHash, sha256: image.sha256 })),
        ancestors: observation.snapshot.sql.AncestorIds.filter(value => value.ItemId.toLowerCase() === row.Id.toLowerCase())
          .map(value => normalize(ids.get(value.ParentItemId.toLowerCase()))).sort() };
    }).sort((a, b) => a.path.localeCompare(b.path));
    return { name: observation.phase, error: observation.error, scanException: observation.scan?.Exception ?? null, items };
  }) }));
}

test('Book/Photo compound raw, helpers, runtime, sources and final native files retain their actual identities', async () => {
  const proof = JSON.parse(await readFile(provenanceUrl));
  const seen = new Map();
  const verify = async input => {
    if (seen.has(input.path)) { assert.equal(seen.get(input.path), input.sha256, input.path); return; }
    seen.set(input.path, input.sha256);
    const bytes = await readFile(input.path);
    assert.equal(bytes.length, input.bytes, input.path);
    assert.equal(digest(bytes), input.sha256, input.path);
    if (input.path.endsWith('.json') && bytes.includes(Buffer.from('"requiredInputs"'))) {
      for (const child of JSON.parse(bytes).requiredInputs ?? []) await verify(child);
    }
  };
  for (const input of [proof.rawRecording, proof.input, proof.native, ...proof.requiredInputs]) await verify(input);
  const raw = JSON.parse(await readFile(proof.rawRecording.path));
  assert.equal(raw.actualExecution, true);
  assert.equal(raw.inputSha256, proof.input.sha256);
  assert.deepEqual(native.cases, projectNative(raw));
  assert.equal(native.cases.length, 14);
  assert.equal(native.cases.reduce((count, value) => count + value.steps.length, 0), 61);
});

// A small genuine ZIP writer supplies the same logical input entry names and
// bytes as native ZipArchive. Container timestamps/compression are not golden.
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte;
    for (let index = 0; index < 8; index++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0; };
  for (const [name, bytes] of entries) {
    const key = Buffer.from(name), header = Buffer.alloc(30), directory = Buffer.alloc(46), sum = crc(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(key.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(sum, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(key.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(header, key, bytes); central.push(directory, key); offset += header.length + key.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function applyChanges(changes, { media, metadata }) {
  const target = relative => { assert.ok(!path.isAbsolute(relative)); const resolved = path.resolve(media, relative);
    assert.ok(resolved.startsWith(media + path.sep)); return resolved; };
  for (const change of changes) {
    const filename = target(change.path), sidecar = /\.(xml|opf)$/iu.test(change.path);
    if (change.kind === 'mkdir') { await mkdir(filename, { recursive: true }); continue; }
    if (change.kind === 'remove-directory') { await rm(filename, { recursive: true }); continue; }
    if (change.kind === 'remove-file') {
      await rm(filename); if (sidecar) await rm(path.join(metadata, change.path)); continue;
    }
    if (change.kind === 'move-file') { await rename(filename, target(change.destination)); continue; }
    await mkdir(path.dirname(filename), { recursive: true });
    const asset = change.asset && matrix.assets.find(value => value.id === change.asset);
    const bytes = asset ? await readFile(assetUrls.get(change.asset)) : null;
    if (asset) assert.equal(digest(bytes), asset.sha256);
    if (change.kind === 'copy') await writeFile(filename, bytes);
    else if (change.kind === 'comic') await writeFile(filename, zip([
      ['ComicInfo.xml', Buffer.from(change.text)], ['cover.png', bytes]]));
    else if (change.kind === 'text') {
      if (sidecar) {
        const actual = path.join(metadata, change.path); await mkdir(path.dirname(actual), { recursive: true });
        await writeFile(actual, change.text);
        await writeFile(filename, '<media-decoy>Wrong sidecar storage</media-decoy>');
      } else await writeFile(filename, change.text);
    } else assert.fail('Undeclared mutation ' + change.kind);
  }
}

async function snapshot(runtime, database, { identity, program }) {
  const rows = await database.rows('BaseItems'), ancestors = await database.rows('AncestorIds');
  const images = await database.rows('BaseItemImageInfos');
  const expand = value => typeof value === 'string' ? value.replace(/%MetadataPath%/giu, path.join(program, 'metadata'))
    .replace(/%AppDataPath%/giu, path.join(program, 'data')) : value;
  const normalize = value => typeof value !== 'string' ? null : slash(expand(value))
    .replace(slash(identity), '$MEDIA').replace(slash(program), '$PROGRAM');
  const ids = new Map(rows.map(row => [row.Id.toLowerCase(), normalize(row.Path) ?? '$NONPATH:' + row.Type + ':' + row.Name]));
  const projected = [];
  for (const row of rows.filter(value => slash(value.Path)?.startsWith(slash(identity) + '/'))) {
    const itemImages = [];
    const loaded = images.some(value => value.ItemId === row.Id) ? await runtime.images.load(row.Id) : null;
    for (const image of images.filter(value => value.ItemId === row.Id)) {
      const filename = expand(image.Path), bytes = await loaded.imageAssets.read(filename);
      itemImages.push({ kind: image.ImageType, extension: path.extname(filename),
        location: slash(filename).startsWith(slash(identity) + '/') ? 'local' : 'internal',
        width: image.Width, height: image.Height, blurHash: Buffer.from(image.Blurhash ?? '').toString('utf8'), sha256: digest(bytes) });
    }
    projected.push({ path: normalize(row.Path), type: row.Type, name: row.Name, isFolder: row.IsFolder,
      mediaType: row.MediaType, parent: ids.get(row.ParentId?.toLowerCase()) ?? null,
      seriesName: row.SeriesName, index: row.IndexNumber, overview: row.Overview, genres: row.Genres ?? '',
      width: row.Width ?? 0, height: row.Height ?? 0, images: itemImages,
      ancestors: ancestors.filter(value => value.ItemId === row.Id).map(value => ids.get(value.ParentItemId.toLowerCase()) ?? null).sort() });
  }
  return projected.sort((a, b) => a.path.localeCompare(b.path));
}

for (const sample of matrix.cases) test('fresh actual Book/Photo global pipeline: ' + sample.name, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-photo-global-'));
  const database = await createPostgresTestDatabase(null, 'book_photo_scan');
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('book-photo-global-'));
      await rm(directory, { recursive: true });
    }
  });
  const program = path.join(directory, 'program'), media = path.join(directory, 'original'), metadata = path.join(directory, 'sidecars');
  await mkdir(path.join(media, 'Subjects'), { recursive: true });
  await mkdir(path.join(metadata, 'Subjects'), { recursive: true });
  await mkdir(path.join(directory, 'ancestors'));
  const errors = [];
  runtime = await createRuntime({ database, programDataPath: program, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'), serverId: 'book-photo-global',
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push({ name: error.name, code: error.code, message: error.message }) });
  const storage = runtime.storage, definition = storage.configuration(), identity = 'Z:\\FreshCompound';
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  definition.instances.push({ id: 'fresh-original', type: 'local', config: { root: media, writable: true } },
    { id: 'fresh-sidecar', type: 'local', config: { root: metadata, writable: true } },
    { id: 'fresh-ancestors', type: 'local', config: { root: path.join(directory, 'ancestors'), writable: true } });
  await storage.configure(definition);
  await storage.bindPath({ identityRoot: 'Z:\\', instanceId: 'fresh-ancestors', purpose: 'library', style: 'windows',
    caseSensitive: false, returnAccess: 'Explicit isolated ancestor search; no host-drive fallback.', capabilities });
  for (const [purpose, instanceId] of [['library', 'fresh-original'], ['metadata', 'fresh-sidecar']]) {
    await storage.bindPath({ identityRoot: identity, instanceId, purpose, style: 'windows', caseSensitive: false,
      returnAccess: 'Independent fresh compound ' + purpose + ' storage.', capabilities });
  }
  assert.deepEqual((await database.rows('BaseItems')).filter(row => row.Path?.startsWith(identity)), []);
  await runtime.libraryConfiguration.addVirtualFolder('Subjects', sample.collectionType,
    { ...defaultLibraryOptions(), SaveLocalMetadata: sample.saveLocalMetadata, EnablePhotos: sample.enablePhotos,
      PathInfos: [{ Path: identity + '\\Subjects' }] }, false);
  const expected = native.cases.find(value => value.name === sample.name);
  for (const [index, step] of sample.steps.entries()) {
    await t.test(step.name, async () => {
      await applyChanges(step.changes, { media, metadata });
      const result = await runtime.libraryScanner.runCompleteScan();
      const actual = await snapshot(runtime, database, { identity, program });
      t.diagnostic(JSON.stringify({ case: sample.name, step: step.name, actual, errors, result }));
      assert.equal(expected.steps[index].error, null);
      assert.equal(expected.steps[index].scanException, null);
      assert.deepEqual(actual, expected.steps[index].items);
    });
  }
  assert.ok((await stat(media)).isDirectory());
});
