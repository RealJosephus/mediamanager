import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/book-photo-global-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), matrix = JSON.parse(inputBytes);
const mutationStepMs = matrix.mediaMutationTimeStepSeconds * 1000;
assert.ok(Number.isSafeInteger(mutationStepMs) && mutationStepMs > 1000, 'Media mutation timestamps must cross the native one-second change threshold.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value?.replaceAll('\\', '/');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
const assetUrls = new Map(matrix.assets.map(asset => [asset.id, new URL(asset.filename, inputFile)]));
let nativeExecution;

function actualNativeRun() {
  return nativeExecution ??= (async () => {
    assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'Book/Photo comparison requires the same-run isolated native reference.');
    const output = path.join(validationOutputRoot(), 'book-photo-global-runtime-' + randomUUID());
    await mkdir(output);
    const recording = await recordOracle({ project: 'tests/library/fixtures/book-photo-global-runtime/Oracle.csproj',
      output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}/cases', '{output}/native.json'] });
    const native = parseLosslessJson(await readFile(path.join(output, 'native/native.json'), 'utf8'));
    assert.equal(recording.passed, true); assert.equal(native.actualExecution, true);
    assert.equal(native.inputSha256, digest(inputBytes));
    assert.equal(native.assemblies.find(assembly => assembly.FullName.startsWith('jellyfin,')).sha256, recording.jellyfinDll.sha256);
    const cases = projectNative(native);
    assert.deepEqual(cases.map(sample => sample.name), matrix.cases.map(sample => sample.name));
    return { native, cases, output };
  })();
}

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
    return { name: observation.phase, error: observation.error, scanException: observation.scan?.Exception ?? null,
      mediaMutationInputs: observation.mediaMutationInputs, items };
  }) }));
}

test('Book/Photo executes all fourteen native cases with sixty-one actual global scans and released resources', async () => {
  const { native, cases } = await actualNativeRun();
  assert.equal(cases.length, 14);
  assert.equal(cases.reduce((count, value) => count + value.steps.length, 0), 61);
  for (const sample of native.results) {
    assert.deepEqual(sample.registrations.metadataSavers, []);
    for (const [index, observation] of sample.observations.slice(1).entries()) {
      const modified = Date.parse(sample.mediaTimeAnchor) - (sample.observations.length - 1 - index) * mutationStepMs;
      assert.equal(Date.parse(observation.mediaMutationTime), modified);
      assert.ok(modified < Date.parse(observation.startedAt), 'Media mtime must precede the actual scan and its saves.');
      for (const input of observation.mediaMutationInputs) assert.equal(Date.parse(input.lastWriteTimeUtc), modified, input.path);
    }
    const release = JSON.parse(await readFile(path.join(sample.root, 'release.json')));
    assert.deepEqual(release, { completed: true, resources: ['scheduler', 'provider', 'plugins', 'services', 'image-processor', 'cache-and-tokens'] });
  }
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

async function applyChanges(changes, { media, metadata, mediaModified }) {
  const mediaMutationInputs = [];
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
    if (change.kind === 'copy' || change.kind === 'comic') {
      const before = await stat(filename);
      await utimes(filename, before.atime, mediaModified);
      const observed = (await stat(filename)).mtime;
      assert.equal(observed.getTime(), mediaModified.getTime(), 'Actual media mtime must match its declared scan step.');
      mediaMutationInputs.push({ path: change.path, lastWriteTimeUtc: observed.toISOString() });
    }
  }
  return mediaMutationInputs;
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

for (const sample of matrix.cases) test('postgres: same-platform actual Book/Photo global pipeline: ' + sample.name,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { cases, output } = await actualNativeRun();
  const expected = cases.find(value => value.name === sample.name);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-photo-global-'));
  let database, runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      try { if (database) await dropPostgresTestDatabase(database); }
      finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('book-photo-global-'));
        await rm(directory, { recursive: true });
      }
    }
  });
  database = await createPostgresTestDatabase(null, 'book_photo_scan', { max: 1 });
  const program = path.join(directory, 'program'), media = path.join(directory, 'original'), metadata = path.join(directory, 'sidecars');
  await mkdir(path.join(media, 'Subjects'), { recursive: true });
  await mkdir(path.join(metadata, 'Subjects'), { recursive: true });
  await mkdir(path.join(directory, 'ancestors'));
  const errors = [];
  runtime = await createTestRuntime({ database, programDataPath: program, configurationDirectoryPath: path.join(directory, 'config'),
    storageConfiguration: path.join(directory, 'storage.json'), serverId: 'book-photo-global',
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push({ name: error.name, code: error.code, message: error.message }) });
  for (const plugin of ['nfo', 'tmdb']) await runtime.plugins.setEnabled(plugin, false);
  const identityPath = process.platform === 'win32' ? path.win32 : path.posix;
  const style = process.platform === 'win32' ? 'windows' : 'posix';
  const identity = process.platform === 'win32' ? 'Z:\\FreshCompound' : '/fresh-compound';
  const storage = runtime.storage, definition = storage.configuration();
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  definition.instances.push({ id: 'fresh-original', type: 'local', config: { root: media, writable: true } },
    { id: 'fresh-sidecar', type: 'local', config: { root: metadata, writable: true } },
    { id: 'fresh-ancestors', type: 'local', config: { root: path.join(directory, 'ancestors'), writable: true } });
  await storage.configure(definition);
  await storage.bindPath({ identityRoot: identityPath.parse(identity).root, instanceId: 'fresh-ancestors', purpose: 'library', style,
    caseSensitive: process.platform !== 'win32', returnAccess: 'Explicit isolated ancestor search; no host-drive fallback.', capabilities });
  for (const [purpose, instanceId] of [['library', 'fresh-original'], ['metadata', 'fresh-sidecar']]) {
    await storage.bindPath({ identityRoot: identity, instanceId, purpose, style, caseSensitive: process.platform !== 'win32',
      returnAccess: 'Independent fresh compound ' + purpose + ' storage.', capabilities });
  }
  assert.deepEqual((await database.rows('BaseItems')).filter(row => row.Path?.startsWith(identity)), []);
  await runtime.libraryConfiguration.addVirtualFolder('Subjects', sample.collectionType,
    { ...defaultLibraryOptions(), SaveLocalMetadata: sample.saveLocalMetadata, EnablePhotos: sample.enablePhotos,
      PathInfos: [{ Path: identityPath.join(identity, 'Subjects') }] }, false);
  // Only media-file timestamps use a past window. Sidecar writes and
  // DateLastSaved keep their real wall clocks for OPF/Comic HasChanged.
  const mediaTimeAnchor = Math.floor(Date.now() / 1000) * 1000;
  for (const [index, step] of sample.steps.entries()) {
    await t.test(step.name, async () => {
      const mediaModified = new Date(mediaTimeAnchor - (sample.steps.length - index) * mutationStepMs);
      assert.ok(mediaModified.getTime() < Date.now());
      const mediaMutationInputs = await applyChanges(step.changes, { media, metadata, mediaModified });
      assert.deepEqual(mediaMutationInputs.map(value => value.path), expected.steps[index].mediaMutationInputs.map(value => value.path));
      const result = await runtime.libraryScanner.runCompleteScan();
      const actual = await snapshot(runtime, database, { identity, program });
      await writeFile(path.join(output, `${sample.name}-${index}-candidate.json`), json({
        case: sample.name, step: step.name, mediaTimeAnchor: new Date(mediaTimeAnchor).toISOString(),
        mediaMutationTime: mediaModified.toISOString(), mediaMutationInputs, actual, errors, result, programRoot: program,
        BaseItems: await database.rows('BaseItems'), AncestorIds: await database.rows('AncestorIds'),
        BaseItemImageInfos: await database.rows('BaseItemImageInfos') }));
      assert.equal(expected.steps[index].error, null);
      assert.equal(expected.steps[index].scanException, null);
      assert.deepEqual(actual, expected.steps[index].items);
      if (sample.name === 'book-comic-internal' && step.name === 'replace-comic-input') {
        assert.equal(actual.find(item => item.path === '$MEDIA/Subjects/Story.cbz')?.name, 'Changed Comic Title');
      }
      await writeFile(path.join(output, `${sample.name}-${index}-comparison.json`), json({ passed: true }));
    });
  }
  assert.ok((await stat(media)).isDirectory());
});
