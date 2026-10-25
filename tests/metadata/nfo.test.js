import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import test, { after } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const spoolRoot=await mkdtemp(path.join(os.tmpdir(),'nfo-stream-tests-'));
after(()=>rm(spoolRoot,{recursive:true,force:true}));
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { serializeNfo as prepareNfo } from '../../plugins/nfo/saver.js';
async function serializeNfo(item,context={}) {const prepared=await prepareNfo(item,{fileSystem: testFileSystem, spoolRoot,...context});try {const chunks=[];for await(const chunk of prepared.stream())chunks.push(chunk);return Buffer.concat(chunks);}finally{await prepared.close();}}
import { nfoPaths, nfoHasChanged } from '../../plugins/nfo/paths.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { XmlError } from '../../src/core/xml.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const fixture = (name) => readFile(new URL(`./fixtures/${name}.nfo`, import.meta.url), 'utf8');

test('NFO BOM detection matches actual native TextReader behavior through VFS', async (t) => {
  const oracle = JSON.parse(await readFile(new URL('./fixtures/tmdb-provider-oracle.json', import.meta.url), 'utf8'));
  const registry = new StorageRegistry(); registry.registerType('fixture', () => new MemoryStorageAdapter());
  await registry.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'fixture', capabilities: { create: true, replace: true } });
  t.after(() => registry.close());
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  spoolRoot, vfs });
  for (const sample of oracle.NfoEncodings) {
    const bytes = Buffer.from(sample.Bytes, 'base64');
    const decoded = parseNfo(decodeNativeText(bytes));
    assert.equal(decoded.Item.Name, sample.Title, sample.Name);
    await vfs.write('/media/' + sample.Name + '.nfo', bytes);
    const item = { Type: 'Video', Path: '/media/' + sample.Name + '.mkv' };
    const result = await plugin.getMetadata(item);
    assert.equal(result.Item.Name, sample.Title, sample.Name);
    assert.equal(result.Item.Overview, sample.Overview, sample.Name);
  }
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<movie><title>Old</title><custom>Preserved 中文</custom></movie>', 'utf16le')]);
  await vfs.write('/media/preserve.nfo', original);
  await plugin.save({ Type: 'Video', Path: '/media/preserve.mkv', Name: 'Edited' });
  const handle = await vfs.openRead('/media/preserve.nfo');
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); assert.match(decodeNativeText(Buffer.concat(chunks)), /<custom>Preserved 中文<\/custom>/); }
  finally { await handle.close(); }
});

test('NFO parses baseline Justice League fixture fields, credits, streams and image types', async () => {
  const result = parseNfo(await fixture('Justice League'));
  const item = result.Item;
  assert.equal(item.OriginalTitle, 'Justice League');
  assert.equal(item.ProviderIds.Imdb, 'tt0974015');
  assert.equal(item.ProviderIds.Tmdb, '141052');
  assert.equal(item.ProviderIds.TmdbCollection, '702342');
  assert.equal(item.TmdbCollectionName, 'Justice League Collection');
  assert.equal(item.RunTimeTicks, 62680000000n);
  assert.equal(item.Video3DFormat, 'HalfSideBySide');
  assert.equal(item.Width, 1920); assert.equal(item.Height, 1080);
  assert.equal(item.HasSubtitles, true);
  assert.equal(item.CriticRating, Math.fround(7.6));
  assert.equal(item.PreferredMetadataLanguage, 'en');
  assert.equal(item.PreferredMetadataCountryCode, 'us');
  assert.equal(item.DateCreated, '2019-08-06T09:01:18.0000000Z');
  assert.equal(result.People.length, 20);
  assert.equal(result.People.filter((person) => person.Type === 'Writer').length, 3);
  assert.equal(result.RemoteImages.length, 7);
  assert.equal(item.RemoteTrailers[0].Url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('NFO follows baseline ascending multi-episode merge and missing-tag behavior', async () => {
  const reversed = parseNfo(await fixture('Rising-Reversed'), { type: 'Episode' }).Item;
  assert.equal(reversed.Name, 'Rising (1) / Rising (2)');
  assert.equal(reversed.IndexNumber, 1); assert.equal(reversed.IndexNumberEnd, 2);
  assert.equal(reversed.PremiereDate, '2004-07-16T00:00:00.000Z');
  const item = parseNfo(await fixture('Stargate Atlantis S01E01-E04'), { type: 'Episode' }).Item;
  assert.equal(item.Name, 'Rising / Hide and Seek / Thirty-Eight Minutes');
  assert.equal(item.OriginalTitle, 'Rising (1) / Rising (2) / Hide and Seek / Thirty-Eight Minutes');
  assert.equal(item.IndexNumberEnd, 4);
});

test('NFO episode fixture maps specials, IMDb, cast and dates', async () => {
  const { Item: item, People: people } = parseNfo(await fixture('The Bone Orchard'), { type: 'Episode' });
  assert.equal(item.Name, 'The Bone Orchard'); assert.equal(item.SeriesName, 'American Gods');
  assert.equal(item.AirsAfterSeasonNumber, 2); assert.equal(item.AirsBeforeSeasonNumber, 3);
  assert.equal(item.ProviderIds.Imdb, 'tt5017734');
  assert.equal(people.filter((person) => person.Type === 'Actor').length, 11);
  assert.equal(item.RunTimeTicks, 0n);
});

test('URL-only and trailing URLs retain source precedence and provider-specific behavior', async () => {
  assert.equal(parseNfo('https://www.themoviedb.org/movie/30287').Item.ProviderIds.Tmdb, '30287');
  assert.equal(parseNfo('https://www.themoviedb.org/movie/30287', { type: 'Video' }).Item.ProviderIds.Tmdb, undefined);
  const item = parseNfo('<movie><tmdbid>9</tmdbid></movie> https://www.themoviedb.org/movie/8 tt123456789').Item;
  assert.equal(item.ProviderIds.Tmdb, '9');
  assert.equal(item.ProviderIds.Imdb, 'tt12345678');
});

test('NFO music parser preserves native read/write asymmetry and named season only reads its name', async () => {
  const album = parseNfo('<album><title>A</title><artist>B</artist><musicbrainzalbumid>11111111-2222-3333-4444-555555555555</musicbrainzalbumid></album>', { type: 'MusicAlbum' }).Item;
  assert.equal(album.Name, 'A'); assert.equal(album.Artists, undefined); assert.equal(album.ProviderIds.MusicBrainzAlbum, '11111111-2222-3333-4444-555555555555');
  const season = parseNfo('<tvshow><title>Series</title><namedseason number="2">  Winter  </namedseason></tvshow>', { type: 'Season', indexNumber: 2, seriesSeason: true }).Item;
  assert.equal(season.Name, '  Winter  ');
  assert.equal(season.IndexNumber, 2);
});

test('NFO invalid XML is visible for album but swallowed for movie; DTD is never evaluated', async () => {
  assert.throws(() => parseNfo('<album><title>x</album>', { type: 'MusicAlbum' }), XmlError);
  assert.equal(parseNfo('<movie><title>x</movie>').HasMetadata, true);
  assert.throws(() => parseNfo('<!DOCTYPE album [<!ENTITY x SYSTEM "file:///private">]><album>&x;</album>', { type: 'MusicAlbum' }), /DTD/);
});

test('NFO source rating differences and integer ticks avoid lossy Number coercion', async () => {
  const item = parseNfo('<movie><communityrating>11</communityrating><rating>11</rating><runtime>2147483647 minutes</runtime><uniqueid type="OtherProvider">abc</uniqueid></movie>').Item;
  assert.equal(item.CommunityRating, 11); assert.equal(item.RunTimeTicks, 1288490188200000000n);
  assert.equal(item.ProviderIds.OtherProvider, 'abc');
});

test('NFO paths match DVD, movie, owned video and series-season rules', async () => {
  assert.deepEqual(nfoPaths({ Type: 'Movie', Path: '/films/Movie/film.mkv' }), ['/films/Movie/movie.nfo', '/films/Movie/film.nfo']);
  assert.deepEqual(nfoPaths({ Type: 'Video', Path: '/films/Movie/extra.mkv' }), ['/films/Movie/extra.nfo']);
  assert.deepEqual(nfoPaths({ Type: 'Movie', Path: '/films/DVD', VideoType: 'Dvd' }), ['/films/DVD/VIDEO_TS/VIDEO_TS.nfo', '/films/DVD/movie.nfo', '/films/DVD/DVD.nfo']);
  assert.deepEqual(nfoPaths({ Type: 'Season', Path: '/tv/Show/Season 1' }, { seriesSeason: true, seriesPath: '/tv/Show' }), ['/tv/Show/Season 1/tvshow.nfo', '/tv/Show/tvshow.nfo']);
  assert.equal(nfoHasChanged('2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z'), false);
  assert.equal(nfoHasChanged('2026-01-01T00:01:00.001Z', '2026-01-01T00:00:00Z'), true);
});

test('NFO saver retains custom tags and other provider IDs, writes actual streams, and uses midpoint-to-even runtime', async () => {
  const bytes = await serializeNfo({ Type: 'Movie', Name: '中文 & title', DateCreated: '2026-01-02T03:04:05Z', RunTimeTicks: 900000000n, ProviderIds: { Imdb: 'tt1234567', UnknownSource: '42' } }, {fileSystem: testFileSystem,  existingXml: '<movie><custom foo="bar">keep</custom><title>old</title></movie>', mediaStreams: [{ Type: 'Video', Codec: 'mpeg4', CodecTag: 'DIVX', Width: 1920 }] });
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const xml = bytes.toString('utf8');
  assert.match(xml, /<runtime>2<\/runtime>/); assert.match(xml, /<unknownsourceid>42<\/unknownsourceid>/);
  assert.match(xml, /<custom foo="bar">keep<\/custom>/); assert.match(xml, /<codec>divx<\/codec>/);
  assert.equal(parseNfo(xml).Item.Name, '中文 & title');
});

test('NFO saver writes native self-closing art when no primary or backdrop image exists', async () => {
  const xml = (await serializeNfo({ Type: 'Movie', Name: 'No artwork' }, {
    fileSystem: testFileSystem, images: [{ Type: 'Thumb', Path: '/ignored.jpg' }],
  })).toString('utf8');
  assert.match(xml, /\r\n  <art \/>\r\n/u);
  assert.doesNotMatch(xml, /<art>\s*<\/art>/u);
});

test('NFO saver preserves and orders empty native collection values', async () => {
  const bytes = await serializeNfo({ Type: 'Movie', Name: 'Movie', Studios: ['Scan Fixture Studio', '', null] },
    { fileSystem: testFileSystem });
  const xml = bytes.toString('utf8');
  const empty = [...xml.matchAll(/<studio \/>/gu)].map(match => match.index);
  assert.equal(empty.length, 2);
  assert.ok(empty.every(index => index < xml.indexOf('<studio>Scan Fixture Studio</studio>')));
  assert.deepEqual(parseNfo(xml).Item.Studios, ['Scan Fixture Studio'], 'the native parser intentionally ignores empty elements');
});

test('NFO preserved custom XML keeps mixed text order and inherited namespace bindings', async () => {
  const bytes = await serializeNfo({ Type: 'Movie', Name: 'Movie' }, {fileSystem: testFileSystem,  existingXml: '<movie xmlns:x="urn:test"><x:custom>before<b>bold</b>after</x:custom></movie>' });
  assert.match(bytes.toString('utf8'), /<x:custom xmlns:x="urn:test">before<b>bold<\/b>after<\/x:custom>/);
});

test('NFO custom attribute whitespace survives XML normalization and valid C1 text is preserved', async () => {
  const bytes = await serializeNfo({ Type: 'Movie', Name: 'Movie' }, {fileSystem: testFileSystem,  existingXml: '<movie><custom note="a&#10;b&#9;c&#13;d">\u0080</custom></movie>' });
  assert.match(bytes.toString('utf8'), /note="a&#xA;b&#x9;c&#xD;d"/);
  assert.ok(bytes.toString('utf8').includes('\u0080'));
});

test('NFO applies baseline overview HTML cleanup and rejects invalid XML characters', async () => {
  const bytes = await serializeNfo({ Type: 'Movie', Name: 'Movie', Overview: ' <b>Title</b> &quot;quote&quot; ' }, {fileSystem:testFileSystem});
  assert.equal(parseNfo(bytes.toString('utf8')).Item.Overview, "Title 'quote'");
  await assert.rejects(serializeNfo({ Type: 'Movie', Name: 'bad\u0000name' }, {fileSystem:testFileSystem}), XmlError);
});

test('NFO uses generic VFS for write/read/idempotence and propagates unsupported write', async () => {
  const registry = new StorageRegistry(); registry.registerType('fixture', (config) => new MemoryStorageAdapter(config));
  await registry.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'fixture', capabilities: { create: true, replace: true } });
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  spoolRoot, vfs });
  const item = { Type: 'Video', Path: 'D:\\identity\\test.mkv', Name: 'Test', DateCreated: '2026-01-01T00:00:00Z' };
  const context = { accessPath: '/media/test.mkv' };
  assert.equal((await plugin.save(item, context)).changed, true);
  assert.equal((await plugin.save(item, context)).changed, false);
  assert.equal((await plugin.getMetadata(item, context)).Item.Name, 'Test');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(plugin.save(item, { ...context, signal: controller.signal }));
  await registry.createInstance('readonly', 'fixture', { capabilities: {} }); vfs.mount({ path: '/readonly', instanceId: 'readonly', capabilities: {} });
  await assert.rejects(plugin.save(item, { accessPath: '/readonly/test.mkv' }), { code: 'not-supported' });
  await registry.close();
});

test('NFO user events follow source reason and configuration gates, irrespective of event user', async () => {
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  spoolRoot, vfs: {}, getConfiguration: () => ({ ...defaultNfoConfiguration(), UserId: 'configured-user' }) });
  const item = { IsFileProtocol: true, SupportsLocalMetadata: true }; const calls = [];
  assert.equal(await plugin.onUserDataSaved({ SaveReason: 'PlaybackProgress', Item: item }, (...args) => calls.push(args)), false);
  assert.equal(await plugin.onUserDataSaved({ SaveReason: 'TogglePlayed', Item: item, UserId: 'different-user' }, (...args) => calls.push(args)), true);
  assert.deepEqual(calls, [[item, 'MetadataDownload', ['Nfo']]]);
});

test('NFO refuses destructive writes when existing collections lack authoritative host context', async () => {
  const registry = new StorageRegistry(); registry.registerType('fixture', () => new MemoryStorageAdapter());
  await registry.createInstance('fixture', 'fixture', {}); const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'fixture', capabilities: { create: true, replace: true } });
  const original = Buffer.from('<movie><title>Old</title><actor><name>Existing actor</name></actor></movie>');
  await vfs.write('/media/item.nfo', original);
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  spoolRoot, vfs }); const item = { Type: 'Video', Path: '/media/item.mkv', Name: 'New' };
  await assert.rejects(plugin.save(item), { code: 'metadata-context-required' });
  const handle = await vfs.openRead('/media/item.nfo'); const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); await handle.close();
  assert.deepEqual(Buffer.concat(chunks), original);
  item.PremiereDate = '2024-02-29T00:00:00Z';
  await plugin.save(item, { people: [], getConfiguration: () => ({ ...defaultNfoConfiguration(), ReleaseDateFormat: 'dd/MM/yyyy' }) });
  const updated = await vfs.openRead('/media/item.nfo'); const updatedChunks = []; for await (const chunk of updated.stream) updatedChunks.push(Buffer.from(chunk)); await updated.close();
  const updatedXml = Buffer.concat(updatedChunks).toString();
  assert.match(updatedXml, /<premiered>29\/02\/2024<\/premiered>/);
  assert.equal(parseNfo(updatedXml, { getConfiguration: () => ({ ...defaultNfoConfiguration(), ReleaseDateFormat: 'dd/MM/yyyy' }) }).Item.PremiereDate, '2024-02-29T00:00:00.000Z');
  await registry.close();
});
