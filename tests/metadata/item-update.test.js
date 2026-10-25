import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson, stringifyNativeJson, withNativeFloats } from '../../src/core/json.js';
import { loadLocalizationData } from '../../src/core/localization-data.js';
import { bindItemUpdate } from '../../src/http/item-update-binding.js';
import { applyItemMetadataUpdate, metadataEditFlags, peopleItemTypes } from '../../src/metadata/item-update.js';
import { observeComparison } from '../comparison-observations.js';

const input = JSON.parse(await readFile(new URL('./fixtures/item-update/input.json', import.meta.url), 'utf8'));
const native = parseLosslessJson(await readFile(new URL('./fixtures/item-update/native.json', import.meta.url), 'utf8'));
const videoTypes = new Set(['Movie', 'Episode', 'MusicVideo']);
const languageData = loadLocalizationData();
const findLanguage = value => value == null ? value : languageData.cultures().find(culture => [culture.Name, culture.DisplayName,
  culture.TwoLetterISOLanguageName, ...culture.ThreeLetterISOLanguageNames].some(name => name.toLowerCase() === value.toLowerCase()))?.TwoLetterISOLanguageName ?? value;

test('item update recording and generated DTO schema retain their native input identities', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/item-update/provenance.json', import.meta.url), 'utf8'));
  const sources = {
    native: await readFile(new URL('./fixtures/item-update/native.json', import.meta.url)),
    input: await readFile(new URL('./fixtures/item-update/input.json', import.meta.url)),
    schema: await readFile(new URL('../../src/http/resources/item-update-schema.json', import.meta.url)),
    oracle: await readFile(new URL('./fixtures/item-update/Program.cs', import.meta.url)),
    project: await readFile(new URL('./fixtures/item-update/Oracle.csproj', import.meta.url)),
    buildProperties: await readFile(new URL('../Directory.Build.props', import.meta.url))
  };
  for (const [name, bytes] of Object.entries(sources)) assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.files[name].sha256, name);
  assert.equal(provenance.candidateVerified, false); assert.equal(native.candidateVerified, false);
  assert.equal(provenance.runtime.timezone, 'Asia/Taipei');
  assert.equal(provenance.sourceFilesSha256, provenance.schemaSourceFilesSha256);
});

function storedItem(Type) {
  return { Id: '81000000-0000-0000-0000-000000000001', Type, Name: 'Stored title', ForcedSortName: 'Old sort',
    OriginalTitle: 'Original', OriginalLanguage: 'fr', Overview: 'Stored overview', Genres: ['Old genre'], Tags: ['Old', 'keep'],
    Studios: ['Old studio'], ProductionLocations: ['Old country'], ProviderIds: { Custom: 'old' },
    IsLocked: true, LockedFields: ['Name'], DateCreated: '2020-01-01T00:00:00.0000000Z', RunTimeTicks: 9007199254740993n,
    Tagline: 'Old tagline', IsFolder: ['Series', 'Season', 'MusicAlbum', 'Folder'].includes(Type),
    ...(['Audio', 'MusicAlbum', 'MusicVideo'].includes(Type) ? { Artists: [] } : {}),
    ...(['Audio', 'MusicAlbum'].includes(Type) ? { AlbumArtists: [] } : {}),
    ...(Type === 'Series' ? { AirDays: ['Monday'], AirTime: 'Old time', DisplayOrder: 'Aired' } : {}) };
}

function snapshot(item) {
  const fields = ['Name', 'ForcedSortName', 'OriginalTitle', 'OriginalLanguage', 'CriticRating', 'CommunityRating', 'IndexNumber',
    'ParentIndexNumber', 'Overview', 'Genres', 'Tagline', 'Studios', 'DateCreated', 'EndDate', 'PremiereDate', 'ProductionYear',
    'OfficialRating', 'CustomRating', 'Tags', 'ProductionLocations', 'PreferredMetadataCountryCode', 'PreferredMetadataLanguage',
    'IsLocked', 'LockedFields', 'RunTimeTicks', 'ProviderIds'];
  if (videoTypes.has(item.Type)) fields.push('AspectRatio', 'Video3DFormat');
  if (['Audio', 'MusicAlbum', 'MusicVideo'].includes(item.Type)) fields.push('Artists');
  if (['Audio', 'MusicAlbum'].includes(item.Type)) fields.push('AlbumArtists');
  if (['Audio', 'MusicVideo'].includes(item.Type)) fields.push('Album');
  if (item.Type === 'Series') fields.push('Status', 'AirDays', 'AirTime', 'DisplayOrder');
  if (['Season', 'Episode'].includes(item.Type)) fields.push('SeriesName');
  if (item.Type === 'Episode') fields.push('AirsAfterSeasonNumber', 'AirsBeforeSeasonNumber', 'AirsBeforeEpisodeNumber');
  return parseLosslessJson(stringifyNativeJson(withNativeFloats(Object.fromEntries(fields.map(key => [key, item[key]])), ['CriticRating', 'CommunityRating'])));
}

const updateOutcome = observation => {
  if (observation.error == null) return observation;
  const { error: _error, Message: _message, ...values } = observation;
  return { ...values, failed: true };
};

for (const scenario of input) test(`pinned item update: ${scenario.name}`, async t => {
  const expected = native.results.find(entry => entry.name === scenario.name);
  let actual;
  try {
    const request = bindItemUpdate(parseLosslessJson(scenario.json), scenario.json);
    const item = storedItem(scenario.type);
    const flags = metadataEditFlags(item, request);
    const descendants = [], childMap = new Map();
    const build = input => {
      const child = { Id: `81000000-0000-0000-0000-${String(descendants.length + 2).padStart(12, '0')}`, Type: input.type,
        Name: input.name, Tags: [...input.tags], LockedFields: input.lockedFields ?? [], IsLocked: input.locked ?? false,
        OfficialRating: 'R', CustomRating: 'Old custom', Genres: [], Studios: [], ProductionLocations: [], ProviderIds: {},
        DateCreated: '0001-01-01T00:00:00.0000000Z', IsFolder: ['Folder', 'Season'].includes(input.type),
        ...(input.type === 'Audio' ? { Artists: [], AlbumArtists: [] } : {}) };
      descendants.push(child);
      childMap.set(child, (input.children ?? []).map(build));
      return child;
    };
    childMap.set(item, (scenario.children ?? []).map(build));
    const saves = [], writes = [];
    const save = async current => { saves.push({ Id: current.Id.replaceAll('-', ''), reason: 'MetadataEdit' }); writes.push(snapshot(current)); };
    await applyItemMetadataUpdate(item, request, { findLanguage, save, children: current => childMap.get(current) ?? [] });
    await save(item);
    if (flags.lockChanged && item.IsFolder) for (const child of descendants) { child.IsLocked = item.IsLocked; await save(child); }
    actual = { name: scenario.name, value: snapshot(item), saves,
      people: peopleItemTypes.has(item.Type) ? (request.People ?? []).map(person => ({ Name: person.Name, Role: person.Role, Type: person.Type })) : [],
      queued: flags.displayOrderChanged ? 1 : 0, ...(descendants.length ? { writes, children: descendants.map(snapshot) } : {}) };
  } catch (error) {
    actual = { name: scenario.name, error: { name: error.name, status: error.status, message: error.message, stack: error.stack },
      Message: error.message, ...(error.path ? { Path: error.path, LineNumber: error.line, BytePositionInLine: error.position } : {}) };
  }
  if (actual.error != null || expected.error != null) observeComparison(t, scenario.name + ' metadata edit failure', actual, expected);
  assert.deepEqual(updateOutcome(actual), updateOutcome(expected));
});

test('series cascades ratings and tags through physical season children before the parent save', async () => {
  const series = storedItem('Series');
  const season = { Type: 'Season', Id: 'season', Tags: ['Old', 'keep', 'child'], LockedFields: ['OfficialRating'], OfficialRating: 'R' };
  const episode = { Type: 'Episode', Id: 'episode', Tags: ['Old', 'keep'], LockedFields: ['Tags'], OfficialRating: 'R' };
  const direct = { Type: 'Episode', Id: 'direct', Tags: ['Old'], LockedFields: [] };
  const saves = [];
  await applyItemMetadataUpdate(series, { Name: 'Renamed', OfficialRating: 'PG', CustomRating: 'G', Tags: ['KEEP', 'new'] }, {
    children: item => item === series ? [season, direct] : item === season ? [episode] : [],
    save: async item => saves.push(structuredClone(item))
  });
  assert.deepEqual(saves.map(item => item.Id), ['season', 'episode']);
  assert.equal(season.SeriesName, 'Renamed');
  assert.equal(season.OfficialRating, 'R');
  assert.deepEqual(season.Tags, ['child', 'KEEP', 'new']);
  assert.equal(episode.SeriesName, 'Renamed');
  assert.equal(episode.OfficialRating, 'PG');
  assert.deepEqual(episode.Tags, ['Old', 'keep']);
  assert.equal(direct.OfficialRating, undefined);
});
