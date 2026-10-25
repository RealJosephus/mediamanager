import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { matrix, assetUrls, digest, slash, currentBookPhoto, allTables, fileEvidence, recordCandidate } from './book-photo-global-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('Book/Photo current designated Native independently executes both complete fourteen-case sixty-one-step matrices', async () => {
  const { cases, report } = await currentBookPhoto();
  assert.equal(cases.length, 14);
  assert.equal(cases.reduce((count, value) => count + value.steps.length, 0), 61);
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(report.independentRepeatMatched, true);
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
  const mutations = [];
  for (const change of changes) {
    const startedAt = new Date().toISOString();
    const filename = target(change.path), sidecar = /\.(xml|opf)$/iu.test(change.path);
    let photoReplacementTiming = null;
    if (change.kind === 'copy' && /\.(jpg|jpeg|png|tiff|cr2|webp|avif)$/iu.test(change.path)) {
      const previous = await stat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous?.isFile()) {
        const notBefore = previous.mtimeMs + 1100, deadline = performance.now() + 10_000;
        photoReplacementTiming = { previousModified: previous.mtime.toISOString(), waitStartedAt: new Date().toISOString(),
          notBefore: new Date(notBefore).toISOString() };
        while (Date.now() < notBefore) {
          assert.ok(performance.now() < deadline, 'Real photo replacement time must become observable.');
          await delay(Math.min(100, Math.max(1, notBefore - Date.now())));
        }
        photoReplacementTiming.waitEndedAt = new Date().toISOString();
      }
    }
    if (change.kind === 'mkdir') await mkdir(filename, { recursive: true });
    else if (change.kind === 'remove-directory') await rm(filename, { recursive: true });
    else if (change.kind === 'remove-file') {
      await rm(filename); if (sidecar) await rm(path.join(metadata, change.path));
    } else if (change.kind === 'move-file') await rename(filename, target(change.destination));
    else {
      await mkdir(path.dirname(filename), { recursive: true });
      const asset = change.asset && matrix.assets.find(value => value.id === change.asset);
      const bytes = asset ? await readFile(assetUrls.get(change.asset)) : null;
      if (asset) { assert.equal(bytes.length, asset.bytes); assert.equal(digest(bytes), asset.sha256); }
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
    const observed = change.kind === 'move-file' ? target(change.destination) : filename;
    const details = await stat(observed).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (photoReplacementTiming) assert.ok(details.mtimeMs - Date.parse(photoReplacementTiming.previousModified) > 1000,
      'The actual photo overwrite must cross the public one-second change window.');
    const sidecarInfo = sidecar && details?.isFile() ? await stat(path.join(metadata, change.path)) : null;
    mutations.push({ kind: change.kind, path: change.path, destination: change.destination ?? null, startedAt,
      endedAt: new Date().toISOString(), exists: details !== null, modified: details?.mtime.toISOString() ?? null,
      sidecarModified: sidecarInfo?.mtime.toISOString() ?? null, photoReplacementTiming,
      sha256: details?.isFile() ? digest(await readFile(observed)) : null });
  }
  return mutations;
}

async function snapshot(runtime, database, { identity, program, allowMissingImages = false }) {
  const tables = await allTables(database);
  const rows = tables.BaseItems, ancestors = tables.AncestorIds, images = tables.BaseItemImageInfos;
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
      const filename = expand(image.Path);
      const bytes = await loaded.imageAssets.read(filename).catch(error => {
        if (allowMissingImages && ['not-found', 'ENOENT'].includes(error.code)) return null;
        throw error;
      });
      itemImages.push({ kind: image.ImageType, extension: path.extname(filename),
        location: slash(filename).startsWith(slash(identity) + '/') ? 'local' : 'internal',
        width: image.Width, height: image.Height, blurHash: Buffer.from(image.Blurhash ?? '').toString('utf8'),
        sha256: bytes === null ? null : digest(bytes), base64: bytes?.toString('base64') ?? null });
    }
    projected.push({ path: normalize(row.Path), type: row.Type, name: row.Name, isFolder: row.IsFolder,
      mediaType: row.MediaType, parent: ids.get(row.ParentId?.toLowerCase()) ?? null,
      seriesName: row.SeriesName, index: row.IndexNumber, overview: row.Overview, genres: row.Genres ?? '',
      width: row.Width ?? 0, height: row.Height ?? 0, images: itemImages,
      ancestors: ancestors.filter(value => value.ItemId === row.Id).map(value => ids.get(value.ParentItemId.toLowerCase()) ?? null).sort() });
  }
  return { tables, items: projected.sort((a, b) => a.path.localeCompare(b.path)) };
}

for (const sample of matrix.cases) test('fresh actual Book/Photo global pipeline: ' + sample.name, async t => {
  const { cases, repeatCases } = await currentBookPhoto();
  const expected = cases.find(value => value.name === sample.name);
  const repeated = repeatCases.find(value => value.name === sample.name);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-photo-global-'));
  let database, runtime;
  const cleanup = { runtimeClosed: false, postgresDropped: false, directoryRemoved: false };
  t.after(async () => {
    const failures = [];
    try { await runtime?.close(); cleanup.runtimeClosed = true; } catch (error) { failures.push(error); }
    try { if (database) await dropPostgresTestDatabase(database); cleanup.postgresDropped = true; } catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('book-photo-global-'));
      await rm(directory, { recursive: true }); cleanup.directoryRemoved = true;
    } catch (error) { failures.push(error); }
    await recordCandidate(sample.name + '-cleanup', { cleanup,
      errors: failures.map(error => ({ name: error.name, message: error.message })) });
    if (failures.length) throw new AggregateError(failures, 'Current Book/Photo cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'book_photo_scan');
  const program = path.join(directory, 'program'), media = path.join(directory, 'original'), metadata = path.join(directory, 'sidecars');
  await mkdir(path.join(media, 'Subjects'), { recursive: true });
  await mkdir(path.join(metadata, 'Subjects'), { recursive: true });
  await mkdir(path.join(directory, 'ancestors'));
  const errors = [];
  runtime = await createTestRuntime({ database, programDataPath: program, configurationDirectoryPath: path.join(directory, 'config'),
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
  // Preserve the old contract: default plugins, Windows logical identity and
  // actual write times. The independent runtime fixture owns its other inputs.
  for (const [index, step] of sample.steps.entries()) {
    await t.test(step.name, async () => {
      const observation = { case: sample.name, step: step.name, startedAt: new Date().toISOString(),
        succeeded: false, compared: false, errors };
      try {
        observation.mutations = await applyChanges(step.changes, { media, metadata });
        observation.before = await snapshot(runtime, database, { identity, program, allowMissingImages: true });
        observation.beforeFiles = await fileEvidence(directory);
        observation.scanStartedAt = new Date().toISOString();
        try { observation.result = await runtime.libraryScanner.runCompleteScan(); observation.succeeded = true; }
        catch (error) { observation.scanError = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
        observation.scanEndedAt = new Date().toISOString();
        observation.after = await snapshot(runtime, database, { identity, program });
        observation.afterFiles = await fileEvidence(directory);
        assert.equal(expected.steps[index].succeeded, true, 'Original complete scan succeeds, including malformed-provider cases.');
        assert.equal(observation.succeeded, expected.steps[index].succeeded);
        assert.deepEqual(observation.after.items, expected.steps[index].items);
        assert.equal(repeated.steps[index].succeeded, true);
        assert.deepEqual(observation.after.items, repeated.steps[index].items);
        observation.compared = true;
      } catch (error) {
        observation.failure = { name: error.name, message: error.message, stack: error.stack };
        // A failed image consumer or scan must still retain its SQL/file prefix.
        if (!observation.after) observation.failedTables = await allTables(database);
        if (!observation.afterFiles) observation.failedFiles = await fileEvidence(directory);
        throw error;
      } finally { await recordCandidate(sample.name + '-' + index, observation); }
    });
  }
  assert.ok((await stat(media)).isDirectory());
});
