import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNativeText } from '../../src/core/native-text.js';
import { parseNfoAsync } from '../../plugins/nfo/parser.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';
import { currentNfoFixture, functionalNfo, nfoInputBytes } from './nfo-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const fixture = await currentNfoFixture(new URL('./fixtures/nfo-partial-reader/current-profile.json', import.meta.url));
const { input } = fixture;
const emptyId = '00000000-0000-0000-0000-000000000000';
const itemId = '20000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000001';

const nullable = value => value ?? null;
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
    OriginalTitle: nullable(item.OriginalTitle),
    Overview: nullable(item.Overview),
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

async function candidateResult(sample) {
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
      calls.push({ action: 'save', attempt: attempts, reason, value: snapshotUserData(data) });
      if (sample.failSaveAt === attempts) throw new Error('Injected candidate user-data failure.');
      persisted = snapshotUserData(data);
      if (sample.cancelAfterSave === attempts) cancellation.abort();
    }
  };
  try {
    result = await parseNfoAsync(decodeNativeText(nfoInputBytes(sample)), {
      type, item, seriesSeason: sample.type === 'SeriesSeason', signal: cancellation.signal,
      onUserDataImport: entry => applyNfoUserDataEntry(entry, { getConfiguration: () => ({ ...defaultNfoConfiguration(), UserId: userId }), store, userData })
    });
    hasMetadata = true;
  } catch (caught) { error = caught; hasMetadata = false; }
  return {
    exception: error ? { name: error.name, message: error.message } : null, hasMetadata, item: projectItem(item, sample),
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

test('current partial NFO reader binds all 41 real input files to this run’s designated Native', async () => {
  const { native, report } = await fixture.capture();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(input.length, 41); assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
});

test('current Native partial NFO reader exposes error convergence, prefix commits and user-data order', async () => {
  const { native } = await fixture.capture();
  const byName = new Map(native.results.map(result => [result.name, result]));
  for (const name of ['movie malformed xml is swallowed', 'video malformed xml is swallowed', 'music video malformed xml is swallowed',
    'series malformed xml is swallowed', 'series season malformed xml is swallowed', 'episode malformed xml is swallowed']) {
    assert.equal(byName.get(name).exception, null, name); assert.equal(byName.get(name).hasMetadata, true, name);
  }
  for (const name of ['season malformed xml propagates', 'album malformed xml propagates', 'artist malformed xml propagates']) {
    assert.ok(byName.get(name).exception, name); assert.equal(byName.get(name).hasMetadata, false, name);
  }
  assert.equal(byName.get('scalar commits prior title but not final plot').item.Name, 'Before');
  assert.equal(byName.get('scalar commits prior title but not final plot').item.Overview, null);
  assert.equal(byName.get('complete actor and remote image commit before truncation').people.length, 1);
  assert.equal(byName.get('partial actor is not committed').people.length, 0);
  assert.deepEqual(byName.get('id attributes commit before content and imdb').item.providers, { Tmdb: '101', Tvdb: '202' });
  assert.equal(byName.get('numeric surrogate reference reaches title').item.Name, 'Before\ufffdAfter');
  assert.equal(byName.get('numeric soh reference reaches title').item.Name, 'Before\u0001After');
  assert.equal(byName.get('numeric nul reference reaches title').item.Name, 'Before\0After');
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
  assert.ok(cancelled.exception);
  assert.deepEqual(cancelled.calls.map(call => call.action), ['user', 'data', 'save']);
  const failed = byName.get('second userdata save failure preserves first successful call');
  assert.ok(failed.exception); assert.equal(failed.calls.filter(call => call.action === 'save').length, 2);
  assert.deepEqual(failed.userData.persisted, { Played: true, PlayCount: 0, lastPlayedDate: null });
  const empty = byName.get('empty item id mutates cached userdata but does not save');
  assert.equal(empty.calls.some(call => call.action === 'save'), false);
  assert.deepEqual(empty.userData.current, { Played: true, PlayCount: 2, lastPlayedDate: '2025-01-02T03:04:05.0000000Z' });
  const sequential = byName.get('existing item id saves userdata sequentially with none token');
  assert.deepEqual(sequential.calls.map(call => call.action), ['user', 'data', 'save', 'user', 'data', 'save', 'user', 'data', 'save']);
});

test('production partial NFO reader matches current Native values, failure prefixes and user-data effects', async () => {
  const { native } = await fixture.capture();
  const report = [], observations = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const actual = await candidateResult(sample);
    observations.push({ name: sample.name, ...actual });
    const paths = differencePaths(functionalNfo(actual), functionalNfo(expected));
    if (paths.length) report.push({ name: sample.name, paths });
  }
  await fixture.recordCandidate('reader', observations);
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_READER_DIFF === '1') process.stdout.write(`NFO_READER_DIFF=${JSON.stringify(report)}\n`);
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
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs, getConfiguration: () => ({ ...defaultNfoConfiguration(), UserId: userId }), store, userData });
  const result = await plugin.getMetadata({ Type: 'Video', Path: '/media/item.mkv', Id: itemId });
  assert.deepEqual(calls, ['user', 'data', 'user', 'data']);
  assert.deepEqual(data, { Played: true, PlayCount: 2, LastPlayedDate: null });
  const provider = plugin.providers.find(entry => entry.id === 'VideoNfoProvider');
  assert.deepEqual(await provider.applySideEffects(result, { store, userData }), { applied: 0, ignored: 2 });
  assert.deepEqual(calls, ['user', 'data', 'user', 'data']);
});
