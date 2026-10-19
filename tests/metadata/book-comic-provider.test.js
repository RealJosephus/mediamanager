import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBookComicPlugin } from '../../src/metadata/book-comic-provider.js';
import { comicError, comicLanguage, parseComicInfoXml, readComicInfo } from '../../src/metadata/comic-info-reader.js';
import { readComicBookInfo } from '../../src/metadata/comic-book-info-reader.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';

const provenanceFile = new URL('./fixtures/book-comic/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceFile)), folder = new URL('./', provenanceFile);
const input = JSON.parse(await readFile(new URL('input.json', folder)));
const nativeBytes = await readFile(new URL('native.json', folder)), native = JSON.parse(nativeBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-10-01T00:00:00.0000000Z', sourceRoot = 'Z:\\IndependentComics';

function project(result) {
  if (!result?.HasMetadata) return { HasMetadata: false };
  const item = result.Item ?? result.item;
  return { HasMetadata: true, ResultLanguage: result.ResultLanguage,
    item: { Name: item.Name, SeriesName: item.SeriesName, IndexNumber: item.IndexNumber, Overview: item.Overview,
      ProductionYear: item.ProductionYear, OriginalTitle: item.OriginalTitle, premiereDate: item.PremiereDate ?? item.premiereDate ?? null,
      Genres: item.Genres, Studios: item.Studios, Tags: item.Tags },
    people: (result.People ?? result.people)?.map(person => ({ Name: person.Name, type: person.Type ?? person.type,
      Role: person.Role ?? null, SortOrder: person.SortOrder ?? null, ImageUrl: person.ImageUrl ?? null, ProviderIds: person.ProviderIds })) ?? null };
}

async function fixture(t) {
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  for (const name of ['media', 'metadata']) await storage.createInstance(name, 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  for (const name of ['media', 'metadata']) vfs.mount({ path: '/' + name, instanceId: name,
    capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap(), metadataIdentityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: sourceRoot, accessRoot: '/media', style: 'windows', returnAccess: 'original comic archive only' });
  metadataIdentityMap.addPrefix({ identityRoot: sourceRoot, accessRoot: '/metadata', style: 'windows', returnAccess: 'independent comic metadata only' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap: metadataIdentityMap });
  const imageAssets = new MetadataImageAssets({ vfs, identityMap: metadataIdentityMap });
  const spoolPath = await mkdtemp(path.join(os.tmpdir(), 'mm-comic-archive-'));
  const archives = new BookArchiveService({ vfs, identityMap, spoolPath });
  t.after(async () => { await archives.close(); assert.deepEqual(await readdir(spoolPath), []); await storage.close(); await rm(spoolPath, { recursive: true }); });
  return { vfs, identityMap, fileSystem, archives, spoolPath,
    async setup(sample, observed) {
      const base = sample.name, filename = 'book' + (sample.extension ?? '.cbz'), identity = path.win32.join(sourceRoot, base, filename);
      for (const mount of ['media', 'metadata']) await vfs.mkdir('/' + mount + '/' + base);
      if (sample.directory) for (const mount of ['media', 'metadata']) await vfs.mkdir('/' + mount + '/' + base + '/' + filename);
      const original = observed.source.path;
      const actualAssets = native.assets.filter(row => row.scope === sample.name && row.path.includes('metadata-cases'));
      for (const row of actualAssets) {
        const relative = path.win32.relative(path.win32.dirname(original), row.path).replaceAll('\\', '/');
        await vfs.write((row.path === original ? '/media/' : '/metadata/') + base + '/' + relative, await readFile(row.path), { overwrite: false, modified: stamp });
      }
      const fileSystemMetadata = async () => {
        if (sample.lookupFailure) throw comicError('IOException', 'Injected original-media lookup failure.');
        try { return { exists: true, ...await vfs.stat(identityMap.resolve({ identityPath: identity, style: 'windows' })) }; }
        catch (error) { if (error.code !== 'not-found') throw error; return { exists: false, kind: 'directory', modified: '0001-01-01T00:00:00.0000000Z' }; }
      };
      const fs = sample.sidecarLookupFailure ? { ...fileSystem, stat() { throw comicError('IOException', 'Injected metadata lookup failure.'); } } : fileSystem;
      const logs = [], logger = Object.fromEntries(['debug', 'warn', 'error'].map(level => [level, () => logs.push(level === 'warn' ? 'Warning' : level[0].toUpperCase() + level.slice(1))]));
      const [provider] = createBookComicPlugin({ fileSystem: fs, openArchive: archives.openArchive, logger }).providers;
      const item = { Id: sample.name, Path: identity, Name: 'Stored', DateLastSaved: '2026-09-30T23:59:59.9999999Z' };
      return { provider, item, context: { fileSystemMetadata, imageAssets, signal: sample.cancelled ? AbortSignal.abort() : undefined }, logs };
    } };
}

test('Comic native provenance binds new source build, exact raw records, real archive inputs and returned streams', async () => {
  const descriptors = [...provenance.files, ...provenance.sources, ...Object.values(provenance.proof), ...provenance.assemblies,
    ...provenance.assets, ...provenance.upstream, provenance.upstreamManifest, ...provenance.previousAttempts.map(row => row.record),
    ...provenance.supplementalRar.flatMap(row => [row.record, row.raw, row.input, row.oracleAssembly, row.selected])];
  for (const descriptor of descriptors) assert.equal(hash(await readFile(descriptor.path)), descriptor.sha256, descriptor.path);
  assert.equal(hash(nativeBytes), provenance.proof.rawRecording.sha256);
  assert.equal(hash(await readFile(new URL('input.json', folder))), native.inputSha256);
  assert.equal(native.actualProviders && native.actualComicReaders && native.actualArchiveEngines, true);
  assert.equal(native.results.length, input.metadataCases.length * 4);
  assert.ok(native.covers.every(row => row.sourceUnlocked));
  for (const sample of native.covers.filter(row => row.hasImage)) assert.equal(hash(await readFile(sample.coverPath)), sample.sha256);
});

test('ComicInfo and ComicBookInfo readers preserve actual native field, error, namespace and encoding contracts', async t => {
  for (const sample of input.metadataCases) for (const provider of ['comment', 'external', 'internal']) {
    if (sample.cancelled || sample.lookupFailure || sample.sidecarLookupFailure || sample.directory || sample.missing) continue;
    if (provider !== 'external' && sample.extension && sample.extension.toLowerCase() !== '.cbz') continue;
    if (provider === 'internal' && sample.internalKey && sample.internalKey !== 'ComicInfo.xml') continue;
    if (provider === 'comment' && !sample.comment?.trim()) continue;
    const xml = provider === 'external' ? sample.xml ?? sample.genericXml : sample.internalXml ?? sample.xml;
    if (provider !== 'comment' && xml == null && !sample.xmlBase64) continue;
    await t.test(sample.name + ':' + provider, () => {
      const expected = native.results.find(row => row.name === sample.name && row.provider === provider);
      let result = { HasMetadata: false }, error = null;
      try {
        if (provider === 'comment') { try { result = readComicBookInfo(sample.comment); } catch { /* native provider catches all JSON/reader errors */ } }
        else {
          const bytes = sample.xmlBase64 ? Buffer.from(sample.xmlBase64, 'base64') : sample.encoding === 'utf16le'
            ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : Buffer.from(xml, sample.encoding === 'latin1' ? 'latin1' : 'utf8');
          let document; try { document = parseComicInfoXml(bytes, { allowDtd: provider === 'internal', preserveWhitespace: provider !== 'internal' }); } catch { /* native XML load catches */ }
          if (document) result = readComicInfo(document);
        }
      } catch (caught) { error = caught.nativeException ?? caught.name; }
      assert.equal(error, expected.error); assert.deepEqual(project(result), project(expected.result));
    });
  }
});

test('Comic provider reads real media ZIP and independent metadata VFS in native precedence, retaining failure and cancellation boundaries', async t => {
  const f = await fixture(t);
  for (const sample of input.metadataCases) await t.test(sample.name, async () => {
    const expected = native.results.find(row => row.name === sample.name && row.provider === 'combined');
    const row = await f.setup(sample, expected);
    let changed = null, changeError = null, error = null, result = null;
    try { changed = await row.provider.hasChanged(row.item, row.context); } catch (caught) { changeError = caught.nativeException ?? caught.name; }
    assert.equal(changeError, expected.changeError); assert.equal(changed, expected.changed);
    row.logs.length = 0;
    try { result = await row.provider.getMetadata(row.item, row.context); } catch (caught) { error = caught.nativeException ?? caught.name; }
    assert.equal(error, expected.error); assert.deepEqual(project(result), project(expected.result));
    assert.deepEqual(row.logs, expected.logs.map(row => row.level));
    assert.deepEqual(await readdir(f.spoolPath), []);
    if (changed) { row.item.DateLastSaved = stamp; assert.equal(await row.provider.hasChanged(row.item, row.context), false); }
  });
});

test('Comic language conversion uses actual native ISO language mappings and errors', () => {
  for (const sample of native.languages) {
    if (sample.error) assert.throws(() => comicLanguage(sample.value), error => error.nativeException === sample.error);
    else assert.equal(comicLanguage(sample.value), sample.constructed, JSON.stringify(sample.value));
  }
});

test('Comic external XML opens its scoped metadata handle before cancellation and always closes it', async () => {
  const events = [], signal = AbortSignal.abort();
  const [provider] = createBookComicPlugin({ fileSystem: { async stat() { return { isFile: () => true, modified: stamp }; } } }).providers;
  const result = await provider.getMetadata({ Path: 'Z:\\Comics\\book.cbr' }, { signal,
    fileSystemMetadata: async () => ({ exists: true, kind: 'file' }),
    imageAssets: { async openRead() { events.push('open'); return { stream: (async function* () { events.push('read'); yield Buffer.from('<ComicInfo/>'); })(), async close() { events.push('close'); } }; } } });
  assert.deepEqual(result, { HasMetadata: false }); assert.deepEqual(events, ['open', 'close']);
});
