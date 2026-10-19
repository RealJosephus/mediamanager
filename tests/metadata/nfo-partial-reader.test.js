import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { decodeNativeText } from '../../src/core/native-text.js';
import { parseNfoAsync } from '../../plugins/nfo/parser.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';

const root = new URL('./fixtures/nfo-partial-reader/', import.meta.url);
const [input, native, provenance, historicalDifferences] = await Promise.all(
  ['input.json', 'native.json', 'provenance.json', 'candidate-differences.json']
    .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyId = '00000000-0000-0000-0000-000000000000';
const itemId = '20000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000001';

function inputBytes(sample) {
  const encoding = sample.encoding ?? 'utf8';
  if (encoding === 'utf8-markers') return Buffer.from(sample.text.replaceAll('{{NUL}}', '\0'));
  if (encoding === 'utf8-malformed') {
    const [before, after] = sample.text.split('{{BAD_UTF8}}');
    return Buffer.concat([Buffer.from(before), Buffer.from([0xc3, 0x28]), Buffer.from(after)]);
  }
  const encodings = {
    utf8: ['utf8'],
    'utf8-bom': ['utf8', [0xef, 0xbb, 0xbf]],
    'utf16le-bom': ['utf16le', [0xff, 0xfe]],
    'utf16le-no-bom': ['utf16le'],
  };
  if (encodings[encoding]) {
    const [codec, preamble = []] = encodings[encoding];
    return Buffer.concat([Buffer.from(preamble), Buffer.from(sample.text, codec)]);
  }
  const littleEndian = encoding === 'utf32le-bom';
  if (littleEndian || encoding === 'utf32be-bom') {
    const scalars = [...sample.text].map(character => character.codePointAt(0));
    const bytes = Buffer.alloc(4 + scalars.length * 4);
    bytes.writeUInt32BE(littleEndian ? 0xfffe0000 : 0x0000feff, 0);
    scalars.forEach((scalar, index) => bytes[littleEndian ? 'writeUInt32LE' : 'writeUInt32BE'](scalar, 4 + index * 4));
    return bytes;
  }
  if (encoding === 'utf16be-bom') {
    const little = Buffer.from(sample.text, 'utf16le');
    const bytes = Buffer.alloc(2 + little.length); bytes[0] = 0xfe; bytes[1] = 0xff;
    for (let index = 0; index < little.length; index += 2) { bytes[index + 2] = little[index + 1]; bytes[index + 3] = little[index]; }
    return bytes;
  }
  throw new Error(`Unknown encoding ${encoding}`);
}

const utf16 = value => {
  if (value == null) return null;
  const units = [];
  for (let index = 0; index < value.length; index++) units.push(value.charCodeAt(index));
  return units;
};
// System.Text.Json replaces unpaired UTF-16 surrogates in ordinary JSON text;
// the parallel UTF-16 arrays retain the native in-memory code units.
const nullable = value => value == null ? null : typeof value === 'string'
  ? value.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\ufffd')
  : value;
const oracleDate = value => {
  if (value == null) return null;
  const [seconds, fraction = ''] = (value instanceof Date ? value.toISOString() : String(value)).replace(' ', 'T').replace(/Z$/, '').split('.');
  return `${seconds}.${fraction.padEnd(7, '0').slice(0, 7)}Z`;
};
const snapshotUserData = data => ({ Played: data.Played, PlayCount: data.PlayCount, lastPlayedDate: oracleDate(data.LastPlayedDate) });

function projectItem(item, sample) {
  const video = ['Movie', 'Video', 'MusicVideo', 'Episode'].includes(sample.type);
  return {
    runtimeType: sample.type === 'SeriesSeason' ? 'Season' : sample.type,
    id: item.Id ?? emptyId,
    Name: nullable(item.Name),
    nameUtf16: utf16(item.Name),
    OriginalTitle: nullable(item.OriginalTitle),
    Overview: nullable(item.Overview),
    overviewUtf16: utf16(item.Overview),
    IndexNumber: nullable(item.IndexNumber),
    indexNumberEnd: sample.type === 'Episode' ? nullable(item.IndexNumberEnd) : null,
    ParentIndexNumber: nullable(item.ParentIndexNumber),
    ProductionYear: nullable(item.ProductionYear),
    CommunityRating: nullable(item.CommunityRating),
    CriticRating: nullable(item.CriticRating),
    runTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
    PreferredMetadataLanguage: nullable(item.PreferredMetadataLanguage),
    PreferredMetadataCountryCode: nullable(item.PreferredMetadataCountryCode),
    providers: Object.fromEntries(Object.entries(item.ProviderIds ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    collectionName: sample.type === 'Movie' ? nullable(item.TmdbCollectionName) : null,
    seriesName: sample.type === 'Episode' ? nullable(item.SeriesName) : null,
    width: video ? item.Width ?? 0 : null,
    height: video ? item.Height ?? 0 : null,
    hasSubtitles: video ? item.HasSubtitles ?? false : null,
    artists: sample.type === 'MusicVideo' ? item.Artists ?? [] : null,
    album: sample.type === 'MusicVideo' ? nullable(item.Album) : null,
  };
}

function projectPerson(person) {
  return { Name: person.Name, Type: person.Type, Role: nullable(person.Role), SortOrder: nullable(person.SortOrder), ImageUrl: nullable(person.ImageUrl) };
}

function exceptionName(error) {
  if (!error) return null;
  if (error.name === 'XmlError') return 'XmlException';
  if (error.name === 'AbortError') return 'OperationCanceledException';
  return error.nativeException ?? error.name ?? error.constructor.name;
}

async function candidateResult(sample, frozen) {
  const type = sample.type === 'SeriesSeason' ? 'Season' : sample.type;
  const item = { Type: type, ProviderIds: {}, Id: sample.existingId ? itemId : emptyId,
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.indexNumber == null ? {} : { IndexNumber: sample.indexNumber }) };
  const calls = [];
  const data = { Played: false, PlayCount: 0, LastPlayedDate: null };
  let persisted = null, result, error = null, hasMetadata = false, attempts = 0;
  const cancellation = new AbortController();
  const store = { run: callback => callback({ rows: async table => {
    assert.equal(table, 'Users'); calls.push({ action: 'user', id: userId }); return [{ Id: userId }];
  } }) };
  const userData = {
    readTransient: async () => { calls.push({ action: 'data', value: snapshotUserData(data) }); return data; },
    mutate: async (_requestedUserId, _entryItem, mutate, reason) => {
      calls.push({ action: 'data', value: snapshotUserData(data) });
      mutate(data); attempts++;
      calls.push({ action: 'save', attempt: attempts, reason, tokenCanBeCanceled: false,
        tokenIsCancellationRequested: false, value: snapshotUserData(data) });
      if (sample.failSaveAt === attempts) throw Object.assign(new Error('Injected candidate user-data failure.'), { name: 'IOException' });
      persisted = snapshotUserData(data);
      if (sample.cancelAfterSave === attempts) cancellation.abort();
    }
  };
  try {
    result = await parseNfoAsync(decodeNativeText(Buffer.from(frozen.raw.base64, 'base64')), {
      type, item, seriesSeason: sample.type === 'SeriesSeason', signal: cancellation.signal,
      onUserDataImport: entry => applyNfoUserDataEntry(entry, { configuration: { UserId: userId }, store, userData })
    });
    hasMetadata = true;
  } catch (caught) { error = caught; hasMetadata = false; }
  return {
    exception: exceptionName(error), hasMetadata, item: projectItem(item, sample),
    people: (result?.People ?? []).map(projectPerson),
    remoteImages: (result?.RemoteImages ?? []).map(image => ({ Url: image.Url, Type: image.Type })),
    localImages: (result?.LocalImageCandidates ?? []).map(image => ({ Path: image.Url, Type: image.Type })),
    calls, userData: { current: snapshotUserData(data), persisted }
  };
}

function differencePaths(actual, expected, path = '') {
  if (Object.is(actual, expected)) return [];
  if (actual == null || expected == null || typeof actual !== 'object' || typeof expected !== 'object') return [path || '/'];
  if (Array.isArray(actual) !== Array.isArray(expected)) return [path || '/'];
  const keys = Array.isArray(actual) && Array.isArray(expected)
    ? Array.from({ length: Math.max(actual.length, expected.length) }, (_, index) => String(index))
    : [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return keys.flatMap(key => differencePaths(actual[key], expected[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
}

test('native partial NFO reader fixture binds raw bytes, oracle, source tree and DLL', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.frozenJellyfinHead, provenance.jellyfin.head);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(provenance.runtime.assemblies['MediaBrowser.XbmcMetadata.dll'].sha256, '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e');
  assert.equal(Object.keys(provenance.runtime.assemblies).length, 6);
  assert.equal(provenance.record.sourceFilesSha256, '97164c218f15aec1836dbbf3473561ee3e1fdc11aa748b6b4bc5e80e10e39854');
  assert.equal(provenance.record.oracleAssemblySha256, 'dd7f522b13b98c37f7f44e1d28ccd9adca5934944ec035889ed2844acffc7630');
  assert.equal(Object.keys(provenance.jellyfin.sources).length, 9);
  assert.equal(provenance.jellyfin.sources['MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs'], 'f50fd3439d423330b0bc1c40ab5b413a2c2b3811a14a0955ecd9fbb63b32c152');
  assert.equal(provenance.jellyfin.sources['MediaBrowser.XbmcMetadata/Parsers/EpisodeNfoParser.cs'], 'db512780a4880eba3d5a86de035164e8f7dc3bc63719d8eb5a50e906cb8c2105');
  assert.equal(input.length, 41); assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  for (const [index, sample] of input.entries()) {
    const bytes = inputBytes(sample), frozen = native.results[index];
    assert.equal(bytes.toString('base64'), frozen.raw.base64, sample.name);
    assert.equal(bytes.length, frozen.raw.bytes, sample.name);
    assert.equal(sha256(bytes), frozen.raw.sha256, sample.name);
  }
});

test('native partial NFO reader freezes error convergence, prefix commits and user-data order', () => {
  const byName = new Map(native.results.map(result => [result.name, result]));
  for (const name of ['movie malformed xml is swallowed', 'video malformed xml is swallowed', 'music video malformed xml is swallowed',
    'series malformed xml is swallowed', 'series season malformed xml is swallowed', 'episode malformed xml is swallowed']) {
    assert.equal(byName.get(name).exception, null, name); assert.equal(byName.get(name).hasMetadata, true, name);
  }
  for (const name of ['season malformed xml propagates', 'album malformed xml propagates', 'artist malformed xml propagates']) {
    assert.equal(byName.get(name).exception, 'XmlException', name); assert.equal(byName.get(name).hasMetadata, false, name);
  }
  assert.equal(byName.get('scalar commits prior title but not final plot').item.Name, 'Before');
  assert.equal(byName.get('scalar commits prior title but not final plot').item.Overview, null);
  assert.equal(byName.get('complete actor and remote image commit before truncation').people.length, 1);
  assert.equal(byName.get('partial actor is not committed').people.length, 0);
  assert.deepEqual(byName.get('id attributes commit before content and imdb').item.providers, { Tmdb: '101', Tvdb: '202' });
  assert.deepEqual(byName.get('numeric surrogate reference reaches title').item.nameUtf16, [66, 101, 102, 111, 114, 101, 0xd800, 65, 102, 116, 101, 114]);
  assert.equal(byName.get('numeric soh reference reaches title').item.nameUtf16[6], 1);
  assert.equal(byName.get('numeric nul reference reaches title').item.nameUtf16[6], 0);
  assert.equal(byName.get('literal nul is rejected').item.Name, null);
  assert.equal(byName.get('malformed utf8 uses replacement fallback').item.Name, 'Before�(After');
  for (const [name, title] of [['utf8 bom is detected', 'UTF8 中文'], ['utf16 little endian bom is detected', 'UTF16LE 中文'],
    ['utf16 big endian bom is detected', 'UTF16BE 中文'], ['utf32 little endian bom is detected', 'UTF32LE 中文'],
    ['utf32 big endian bom is detected', 'UTF32BE 中文']]) assert.equal(byName.get(name).item.Name, title, name);
  assert.equal(byName.get('utf16 without bom is treated as utf8').item.Name, null);
  assert.equal(byName.get('xml declaration does not reinterpret decoded text').item.Name, 'Declaration');
  assert.deepEqual(byName.get('movie trailing provider urls are parsed before body').item.providers,
    { Imdb: 'tt12345678', Tmdb: '30287' });
  assert.equal(byName.get('episode one complete block ignores trailing partial block').item.Name, 'Complete');
  assert.equal(byName.get('episode bad later complete block aborts all merge').item.Name, 'Initial');
  assert.equal(byName.get('episode complete blocks sort then merge').item.Name, 'First / Second');
  const cancelled = byName.get('cancellation after first userdata save stops before second node');
  assert.equal(cancelled.exception, 'OperationCanceledException');
  assert.deepEqual(cancelled.calls.map(call => call.action), ['user', 'data', 'save']);
  assert.equal(cancelled.calls[2].tokenCanBeCanceled, false);
  const failed = byName.get('second userdata save failure preserves first successful call');
  assert.equal(failed.exception, 'IOException'); assert.equal(failed.calls.filter(call => call.action === 'save').length, 2);
  assert.deepEqual(failed.userData.persisted, { Played: true, PlayCount: 0, lastPlayedDate: null });
  const empty = byName.get('empty item id mutates cached userdata but does not save');
  assert.equal(empty.calls.some(call => call.action === 'save'), false);
  assert.deepEqual(empty.userData.current, { Played: true, PlayCount: 2, lastPlayedDate: '2025-01-02T03:04:05.0000000Z' });
  const sequential = byName.get('existing item id saves userdata sequentially with none token');
  assert.deepEqual(sequential.calls.map(call => call.action), ['user', 'data', 'save', 'user', 'data', 'save', 'user', 'data', 'save']);
  assert.ok(sequential.calls.filter(call => call.action === 'save').every(call => call.tokenCanBeCanceled === false));
});

test('production partial NFO reader matches every frozen native result', async () => {
  const report = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const frozen = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item,
      people: expected.people, remoteImages: expected.remoteImages, localImages: expected.localImages,
      calls: expected.calls, userData: expected.userData };
    const actual = await candidateResult(sample, expected);
    const paths = differencePaths(actual, frozen);
    if (paths.length) report.push({ name: sample.name, paths });
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_READER_DIFF === '1') process.stdout.write(`NFO_READER_DIFF=${JSON.stringify(report)}\n`);
  // This byte-sealed file is the phase-one diagnostic, not an expected-failure
  // allowlist. Keeping it proves that this test closed real, recorded gaps.
  assert.equal(historicalDifferences.length, 26);
  assert.deepEqual(report, []);
});

test('production NFO provider performs transient user-data reads without saving its zero-id result', async () => {
  const xml = '<movie><watched>true</watched><playcount>2</playcount></movie>';
  const vfs = {
    stat: async path => path === '/media/item.nfo' ? { kind: 'file' } : Promise.reject(Object.assign(new Error('missing'), { code: 'not-found' })),
    openRead: async () => ({ version: null, stream: (async function* () { yield Buffer.from(xml); })(), close: async () => {} }),
  };
  const calls = [], data = { Played: false, PlayCount: 0, LastPlayedDate: null };
  const store = { run: callback => callback({ rows: async () => { calls.push('user'); return [{ Id: userId }]; } }) };
  const userData = {
    readTransient: async (_configuredUserId, entryItem) => {
      assert.equal(entryItem.Id, emptyId); calls.push('data'); return data;
    },
    mutate: async () => assert.fail('BaseNfoProvider must not save user data for its new zero-id result')
  };
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs, configuration: { UserId: userId }, store, userData });
  const result = await plugin.getMetadata({ Type: 'Video', Path: '/media/item.mkv', Id: itemId });
  assert.deepEqual(calls, ['user', 'data', 'user', 'data']);
  assert.deepEqual(data, { Played: true, PlayCount: 2, LastPlayedDate: null });
  const provider = plugin.providers.find(entry => entry.id === 'VideoNfoProvider');
  assert.deepEqual(await provider.applySideEffects(result, { store, userData }), { applied: 0, ignored: 2 });
  assert.deepEqual(calls, ['user', 'data', 'user', 'data']);
});
