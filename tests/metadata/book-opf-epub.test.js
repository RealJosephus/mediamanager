import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { parseOpfDocument, readOpfMetadata } from '../../src/metadata/opf-reader.js';
import { createBookOpfPlugin } from '../../src/metadata/book-opf-provider.js';
import { createBookEpubPlugin } from '../../src/metadata/book-epub-provider.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { dateTicks } from '../../src/library/records.js';
import { formatUtcTicks } from '../../src/syncplay/time.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';

const provenanceUrl = new URL('./fixtures/book-opf-epub/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const json = async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'));
const [input, native, provenance, record] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'record.json'].map(json));
const edgeProvenanceUrl = new URL('./fixtures/book-opf-xml-edges/provenance.json', import.meta.url);
const edgeRoot = new URL('.', edgeProvenanceUrl);
const [edgeInput, edgeNative, edgeProvenance, edgeRecord] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'record.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, edgeRoot), 'utf8'))));
const scalarProvenanceUrl = new URL('./fixtures/book-opf-xml-edges/scalars/provenance.json', import.meta.url);
const scalarRoot = new URL('.', scalarProvenanceUrl);
const [scalarInput, scalarNative, scalarProvenance, scalarRecord] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'record.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, scalarRoot), 'utf8'))));
const resourceProvenanceUrl = new URL('./fixtures/book-opf-xml-edges/resources/provenance.json', import.meta.url);
const resourceRoot = new URL('.', resourceProvenanceUrl);
const [resourceInput, resourceNative, resourceProvenance, resourceRecord] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'record.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, resourceRoot), 'utf8'))));
process.env.TZ = provenance.timezone;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const saved = '2026-10-01T01:02:03.0000000Z';
const identity = filename => 'Z:\\Books\\' + filename.replaceAll('/', '\\');
const book = filename => Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Book'), { Path: identity(filename), DateLastSaved: saved });
const errorKind = error => error.nativeException ?? (error.name === 'AbortError' ? 'OperationCanceledException'
  : error.code === 'invalid-archive' ? 'InvalidDataException' : error.code === 'is-directory' ? 'UnauthorizedAccessException' : error.name);
const fields = ['Name', 'ForcedSortName', 'Overview', 'Studios', 'ProviderIds', 'Genres', 'IndexNumber', 'SeriesName', 'ProductionYear'];
const wireStrings = value => typeof value === 'string' ? value.toWellFormed() : Array.isArray(value) ? value.map(wireStrings)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, wireStrings(part)])) : value;
function projection(result, actual = false) {
  if (!result) return null;
  const item = actual ? result.Item : result.item;
  return wireStrings({ HasMetadata: result.HasMetadata, ResultLanguage: result.ResultLanguage ?? null,
    item: item ? Object.fromEntries(fields.map(field => [field, item[field] ?? null])) : null,
    premiereTicks: item ? actual ? item.PremiereDate ? dateTicks(item.PremiereDate).toString() : null : item.premiereTicks : null,
    rating: item ? actual ? item.CommunityRating ?? null : item.communityRatingDouble : null,
    people: (actual ? result.People : result.people)?.map(person => ({ Name: person.Name, type: actual ? person.Type : person.type,
      Role: person.Role ?? null, ProviderIds: person.ProviderIds ?? {} })) ?? null });
}

test('OPF EPUB fixture binds actual new native execution, source copies, assemblies and every input byte', async () => {
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
  assert.equal(record.jellyfinDll.sha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  for (const entry of provenance.files) assert.equal(hash(await readFile(new URL(entry.filename, root))), entry.sha256, entry.filename);
  for (const pair of provenance.sources) {
    for (const source of [pair.original, pair.captured]) { assert.equal(source.required, true); assert.equal(hash(await readFile(source.filename)), source.sha256, source.filename); }
    assert.equal(pair.original.sha256, pair.captured.sha256, pair.relativePath);
  }
  for (const assembly of provenance.assemblies) {
    assert.equal(assembly.required, true); assert.equal(hash(await readFile(assembly.filename)), assembly.sha256, assembly.name);
    assert.equal(native.assemblies.find(entry => entry.name === assembly.name)?.sha256, assembly.sha256);
  }
  for (const source of record.sourceFiles) {
    const filename = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(hash(await readFile(filename === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(filename, root))), source.sha256);
  }
  assert.equal(native.inputSha256, hash(await readFile(new URL('input.json', root))));
  for (const entry of native.assetFiles) assert.equal(hash(await readFile(new URL('assets/' + entry.path, root))), entry.sha256, entry.path);
  assert.deepEqual([native.readerResults.length, native.providerResults.length, native.epubResults.length, native.archiveResults.length], [68, 13, 38, 5]);
  assert.equal(native.localUtcOffset, '08:00:00');
});

test('OPF raw XML fields, encoding, typed values, partial failures and cancellation match the actual reader', async t => {
  for (const sample of input.readers) await t.test(sample.name, async () => {
    let result = null, error = null; const logs = [];
    try { result = readOpfMetadata(parseOpfDocument(await readFile(new URL('assets/' + sample.file, root))), {
      signal: sample.cancelled ? AbortSignal.abort() : undefined, logger: { error: cause => logs.push(errorKind(cause)) } }); }
    catch (cause) { error = errorKind(cause); }
    const expected = native.readerResults.find(entry => entry.name === sample.name);
    assert.deepEqual(projection(result, true), projection(expected.result));
    assert.equal(error, expected.error); assert.deepEqual(logs, expected.logs);
  });
});

test('additional OPF XML observations retain raw native input, execution and oracle source bytes', async () => {
  assert.equal(edgeRecord.passed, true); assert.equal(edgeRecord.build.status, 0); assert.equal(edgeRecord.process.status, 0);
  assert.equal(edgeRecord.jellyfinDll.sha256, record.jellyfinDll.sha256);
  for (const entry of edgeProvenance.files) assert.equal(hash(await readFile(new URL(entry.filename, edgeRoot))), entry.sha256, entry.filename);
  for (const entry of edgeNative.assetFiles) assert.equal(hash(await readFile(new URL('assets/' + entry.path, edgeRoot))), entry.sha256, entry.path);
  assert.equal(edgeNative.inputSha256, hash(await readFile(new URL('input.json', edgeRoot))));
  for (const source of edgeRecord.sourceFiles) {
    const filename = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(hash(await readFile(filename === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(filename, edgeRoot))), source.sha256);
  }
  assert.equal(edgeNative.readerResults.length, 12);
});

test('OPF XML entity markup, DTD attributes, namespaces and deeper documents match actual XmlDocument consumers', async t => {
  for (const sample of edgeInput.readers) await t.test(sample.name, async () => {
    let result = null, error = null; const logs = [];
    try { result = readOpfMetadata(parseOpfDocument(await readFile(new URL('assets/' + sample.file, edgeRoot))), {
      logger: { error: cause => logs.push(errorKind(cause)) } }); }
    catch (cause) { error = errorKind(cause); }
    const expected = edgeNative.readerResults.find(entry => entry.name === sample.name);
    assert.equal(error, expected.error); assert.deepEqual(projection(result, true), projection(expected.result)); assert.deepEqual(logs, expected.logs);
  });
});

test('OPF scalar edge observations bind actual native execution and raw input bytes', async () => {
  assert.equal(scalarRecord.passed, true); assert.equal(scalarRecord.build.status, 0); assert.equal(scalarRecord.process.status, 0);
  assert.equal(scalarRecord.jellyfinDll.sha256, record.jellyfinDll.sha256);
  for (const entry of scalarProvenance.files) assert.equal(hash(await readFile(new URL(entry.filename, scalarRoot))), entry.sha256, entry.filename);
  for (const entry of scalarNative.assetFiles) assert.equal(hash(await readFile(new URL('assets/' + entry.path, scalarRoot))), entry.sha256, entry.path);
  assert.equal(scalarNative.inputSha256, hash(await readFile(new URL('input.json', scalarRoot))));
  for (const source of scalarRecord.sourceFiles) {
    const filename = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(hash(await readFile(filename === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(filename, scalarRoot))), source.sha256);
  }
});

test('OPF initials whitespace and longer encoding declarations match actual native metadata', async t => {
  for (const sample of scalarInput.readers) await t.test(sample.name, async () => {
    const result = readOpfMetadata(parseOpfDocument(await readFile(new URL('assets/' + sample.file, scalarRoot))));
    const expected = scalarNative.readerResults.find(entry => entry.name === sample.name);
    assert.equal(expected.error, null); assert.deepEqual(projection(result, true), projection(expected.result));
  });
});

test('OPF resource observations bind native execution and exact decompressed input bytes', async () => {
  assert.equal(resourceRecord.passed, true); assert.equal(resourceRecord.build.status, 0); assert.equal(resourceRecord.process.status, 0);
  assert.equal(resourceRecord.jellyfinDll.sha256, record.jellyfinDll.sha256);
  for (const entry of resourceProvenance.files) assert.equal(hash(await readFile(new URL(entry.filename, resourceRoot))), entry.sha256, entry.filename);
  for (const entry of resourceNative.assetFiles) assert.equal(hash(gunzipSync(await readFile(new URL('assets/' + entry.path + '.gz', resourceRoot)))), entry.sha256, entry.path);
  assert.equal(resourceNative.inputSha256, hash(await readFile(new URL('input.json', resourceRoot))));
  for (const source of resourceRecord.sourceFiles) {
    const filename = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(hash(await readFile(filename === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(filename, resourceRoot))), source.sha256);
  }
});

test('OPF entity expansion remains bounded while valid deeper and larger documents retain native metadata', async t => {
  for (const sample of resourceInput.cases) await t.test(sample.name, async () => {
    const bytes = gunzipSync(await readFile(new URL('assets/' + sample.file + '.gz', resourceRoot)));
    let error = null, length = null, sha = null;
    try { const item = readOpfMetadata(parseOpfDocument(bytes)).Item; length = item.Name.length; sha = hash(item.Name); }
    catch (cause) { error = errorKind(cause); }
    const expected = resourceNative.results.find(entry => entry.name === sample.name);
    assert.deepEqual({ error, length, sha }, { error: expected.error, length: expected.length, sha: expected.sha });
  });
});

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-opf-epub-'));
  const registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  const media = await registry.createInstance('media', 'memory', {}), metadata = await registry.createInstance('metadata', 'memory', {});
  const vfs = new VirtualFileSystem(registry), mediaMap = new IdentityAccessMap(), metadataMap = new IdentityAccessMap();
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} }); vfs.mount({ path: '/metadata', instanceId: 'metadata', capabilities: {} });
  for (const [mapping, accessRoot] of [[mediaMap, '/media'], [metadataMap, '/metadata']]) mapping.addPrefix({ identityRoot: 'Z:\\Books', accessRoot,
    style: 'windows', returnAccess: 'Independent isolated Book source and metadata instances.' });
  const archives = new BookArchiveService({ vfs, identityMap: mediaMap, spoolPath: directory });
  t.after(async () => { try { await archives.close(); await registry.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const directories = new Set(['/']);
  for (const entry of native.assetFiles) {
    const bytes = await readFile(new URL('assets/' + entry.path, root));
    let parent = '';
    for (const segment of path.posix.dirname(entry.path).split('/').filter(segment => segment !== '.')) {
      parent += '/' + segment;
      if (directories.has(parent)) continue;
      for (const adapter of [media, metadata]) await adapter.mkdir(parent);
      directories.add(parent);
    }
    for (const adapter of [media, metadata]) {
      const sample = input.opf.find(sample => entry.path.startsWith('opf/' + sample.name + '/'));
      await adapter.write('/' + entry.path, bytes, { modified: sample ? formatUtcTicks(dateTicks(saved) + BigInt(sample.deltaTicks)) : saved });
    }
  }
  await media.mkdir('/epub/directory.epub');
  const fileSystem = new StorageFileSystem({ vfs, identityMap: metadataMap });
  const context = item => ({ async fileSystemMetadata() {
    try { return { ...await vfs.stat(mediaMap.resolve({ identityPath: item.Path, style: 'windows' })), exists: true }; }
    catch (error) {
      if (error.code !== 'not-found') throw error;
      return { exists: false, kind: path.win32.extname(item.Path) ? 'directory' : 'file' };
    }
  } });
  return { directory, registry, media, metadata, vfs, mediaMap, metadataMap, fileSystem, archives, context };
}

test('OPF sidecar selection and exact timestamp changes match actual native filesystem observations', async t => {
  const fixture = await setup(t);
  for (const sample of input.opf) await t.test(sample.name, async () => {
    const item = book(sample.path), logs = [], context = fixture.context(item);
    const fileSystem = { stat: fixture.fileSystem.stat.bind(fixture.fileSystem), async readFile(filename) {
      if (sample.locked) throw Object.assign(new Error('Controlled equivalent of native locked file read.'), { nativeException: 'IOException' });
      return fixture.fileSystem.readFile(filename);
    } };
    const provider = createBookOpfPlugin({ fileSystem, logger: { error: cause => logs.push(errorKind(cause)) } }).providers[0];
    const changed = await provider.hasChanged(item, context);
    let result = null, error = null;
    try { result = await provider.getMetadata(item, { ...context, signal: sample.cancelled ? AbortSignal.abort() : undefined }); }
    catch (cause) { error = errorKind(cause); }
    const expected = native.providerResults.find(entry => entry.name === sample.name);
    assert.equal(changed, expected.changed); assert.equal(error, expected.error);
    assert.deepEqual(projection(result, true), projection(expected.result)); assert.deepEqual(logs, expected.logs);
  });
});

test('EPUB metadata and dynamic covers use the production archive reader over actual native ZIP assets', async t => {
  const fixture = await setup(t), [provider, cover] = createBookEpubPlugin({ openArchive: fixture.archives.openArchive }).providers;
  for (const sample of input.epubs) await t.test(sample.name, async () => {
    const item = book(sample.path), signal = sample.cancelled ? AbortSignal.abort() : undefined;
    let result = null, error = null, image = null, imageError = null;
    try { result = await provider.getMetadata(item, { ...fixture.context(item), signal }); } catch (cause) { error = errorKind(cause); }
    try { image = await cover.getImage(item, { type: 'Primary', signal }); } catch (cause) { imageError = errorKind(cause); }
    const expected = native.epubResults.find(entry => entry.name === sample.name);
    assert.equal(error, expected.error); assert.deepEqual(projection(result, true), projection(expected.result));
    assert.equal(imageError, expected.coverError); assert.equal(imageError ? null : Boolean(image), expected.hasCover);
    if (image) {
      assert.equal(hash(image.bytes), expected.coverSha);
      assert.equal(image.mimeType, { Png: 'image/png', Jpg: 'image/jpeg', Gif: 'image/gif', Bmp: 'image/bmp' }[expected.coverFormat]);
    }
    assert.deepEqual(await readdir(fixture.directory), [], 'each archive lease removes its operation-owned spool');
  });
});

test('raw ZIP names, Unicode extra fields and duplicate lookup follow actual native entry observations', async t => {
  const fixture = await setup(t);
  for (const sample of input.archives) await t.test(sample.name, async () => {
    const archive = await fixture.archives.openArchive(book(sample.file), { zipOnly: true });
    try {
      const expected = native.archiveResults.find(entry => entry.name === sample.name);
      assert.deepEqual(archive.entries.map(entry => ({ FullName: entry.key, Length: Number(entry.size) })), expected.entries);
      for (const query of expected.queries) {
        const entry = archive.findEntry(query.key); assert.equal(Boolean(entry), query.found);
        if (entry) assert.equal(hash(await archive.read(entry)), query.sha);
      }
    } finally { await archive.close(); }
  });
});

test('Book local provider declarations preserve configured order without forced metadata or fabricated monitors', () => {
  const registry = new MetadataRegistry();
  registry.register(createBookOpfPlugin({ fileSystem: { stat() {}, readFile() {} } }));
  registry.register(createBookEpubPlugin({ openArchive() {} }));
  const local = registry.discover({ item: book('book.epub'), kind: 'local', libraryOptions: { LocalMetadataReaderOrder: ['EPUB Metadata', 'Open Packaging Format'] } });
  assert.deepEqual(local.map(provider => provider.name), ['EPUB Metadata', 'Open Packaging Format']);
  assert.equal(local[0].hasChanged, undefined); assert.equal(typeof local[1].hasChanged, 'function');
  assert.ok(local.every(provider => !provider.forced));
  const cover = registry.discover({ item: book('book.epub'), kind: 'image' })[0];
  assert.equal(cover.imageSource, 'dynamic'); assert.deepEqual(cover.imageTypes, ['Primary']);
});

test('embedded EPUB reads original media while OPF sidecars read the independent metadata backend', async t => {
  const fixture = await setup(t), filename = 'epub/rich-with-cover.epub';
  await fixture.metadata.write('/' + filename, Buffer.from('Different metadata backend object.'));
  const item = book(filename), expected = native.epubResults.find(entry => entry.name === 'rich-with-cover');
  const [provider, cover] = createBookEpubPlugin({ openArchive: fixture.archives.openArchive }).providers;
  assert.deepEqual(projection(await provider.getMetadata(item, fixture.context(item)), true), projection(expected.result));
  assert.equal(hash((await cover.getImage(item, { type: 'Primary' })).bytes), expected.coverSha);
  const sidecar = 'opf/specific-first/book.opf';
  await fixture.media.write('/' + sidecar, Buffer.from('<wrong-media-sidecar/>'));
  const opf = createBookOpfPlugin({ fileSystem: fixture.fileSystem }).providers[0], other = book('opf/specific-first/book.epub');
  assert.equal((await opf.getMetadata(other, fixture.context(other))).Item.Name, 'Specific');
});

test('controlled EPUB archive seams preserve cancellation, failure prefixes and closure', async t => {
  const rich = await readFile(new URL('assets/reader/rich.opf', root));
  const container = Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfile full-path="OPS/package.opf"/></container>');
  for (const mode of ['cancelled missing container', 'cancelled valid XML', 'cancelled invalid XML', 'ordinary read failure', 'cover cancelled before open']) await t.test(mode, async () => {
    let opened = 0, closed = 0, reads = 0;
    const entries = mode === 'cancelled missing container' ? [] : [{ key: 'META-INF\\container.xml' }, { key: 'OPS/package.opf' }];
    const signal = mode.startsWith('cancelled') || mode === 'cover cancelled before open' ? AbortSignal.abort() : undefined;
    const openArchive = async (_item, options) => {
      opened++; assert.equal(options.signal, undefined); assert.equal(options.zipOnly, true);
      return { entries, findEntry: name => entries.find(entry => entry.key === name) ?? null, async read(entry, options = {}) {
        reads++; assert.equal(options.signal, undefined);
        if (mode === 'ordinary read failure') throw new Error('Controlled archive read failure.');
        return entry === entries[0] ? container : mode === 'cancelled invalid XML' ? Buffer.from('<broken>') : rich;
      }, async close() { closed++; } };
    };
    const [provider, cover] = createBookEpubPlugin({ openArchive }).providers;
    const item = book('controlled.epub');
    if (mode === 'cover cancelled before open') {
      await assert.rejects(cover.getImage(item, { signal }), error => error.name === 'AbortError'); assert.equal(opened, 0); return;
    }
    const work = provider.getMetadata(item, { signal, fileSystemMetadata: async () => ({ kind: 'file' }) });
    if (mode === 'cancelled missing container') assert.equal((await work).HasMetadata, false);
    else await assert.rejects(work, error => mode === 'cancelled valid XML' ? error.name === 'AbortError'
      : mode === 'cancelled invalid XML' ? error.nativeException === 'XmlException' : error.message === 'Controlled archive read failure.');
    assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(reads, mode === 'cancelled missing container' ? 0 : mode === 'ordinary read failure' ? 1 : 2);
  });
});
