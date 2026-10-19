import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { parseSeriesStatus, parseAirDays } from '../../src/metadata/television.js';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { tmdbExternalUrls } from '../../plugins/tmdb/external.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';

// The recorded reference DLL uses Windows China Standard Time for local DateTime conversion.
process.env.TZ = 'Asia/Shanghai';

const inputs = JSON.parse(readFileSync(new URL('./fixtures/tmdb-provider-input.json', import.meta.url)));
const native = JSON.parse(readFileSync(new URL('./fixtures/tmdb-provider-oracle.json', import.meta.url)));
const searchKeys = ['Name', 'SearchProviderName', 'ImageUrl', 'Overview', 'PremiereDate', 'ProductionYear', 'ProviderIds', 'IndexNumber', 'ParentIndexNumber', 'IndexNumberEnd'];
const itemKeys = ['Type', 'Name', 'OriginalTitle', 'Overview', 'CommunityRating', 'Studios', 'Genres', 'Tags', 'HomePageUrl', 'RunTimeTicks', 'EndDate', 'PremiereDate', 'ProductionYear', 'ProviderIds', 'OfficialRating', 'RemoteTrailers', 'OriginalLanguage', 'IndexNumber', 'ParentIndexNumber', 'IndexNumberEnd', 'Status'];
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const dates = (item) => {
  for (const key of ['PremiereDate', 'EndDate']) if (typeof item[key] === 'string' && item[key].endsWith('Z')) item[key] = new Date(item[key]).toISOString();
  return item;
};
function project(result, operation) {
  if (operation === 'getImages') return result;
  if (operation === 'search') return result.map((entry) => dates(pick(entry, searchKeys)));
  const output = { HasMetadata: result.HasMetadata, QueriedById: result.QueriedById ?? false, ResultLanguage: result.ResultLanguage ?? null, Item: null, People: null };
  if (result.Item) {
    output.Item = dates(pick(result.Item, itemKeys));
    for (const key of ['Studios', 'Genres', 'Tags', 'RemoteTrailers']) output.Item[key] ??= [];
    if (output.Item.RunTimeTicks != null) output.Item.RunTimeTicks = String(output.Item.RunTimeTicks);
    if (output.Item.CommunityRating != null) output.Item.CommunityRating = Math.fround(output.Item.CommunityRating);
    output.Item.RemoteTrailers = output.Item.RemoteTrailers.map((trailer) => pick(trailer, ['Url', 'Name']));
  }
  if (result.People) output.People = result.People.map((person) => pick(person, ['Name', 'Role', 'Type', 'SortOrder', 'ImageUrl', 'ProviderIds']));
  return output;
}
function requestShape(value) {
  const url = new URL(value, 'https://fixture.invalid');
  const query = Object.fromEntries(url.searchParams); delete query.api_key;
  if (query.append_to_response) query.append_to_response = query.append_to_response.split(',').sort().join(',');
  return { path: url.pathname, query };
}

test('TMDB new providers match actual DLL projection and outbound query semantics', async (t) => {
  for (const sample of inputs.cases) await t.test(sample.name, async () => {
    const requests = [];
    const routes = { ...inputs.routes, ...sample.routes };
    const client = new TmdbClient({ configuration: { ...inputs.configuration, ...sample.configuration }, apiKey: 'fixture-key', fetch: async (value) => {
      const url = new URL(value); requests.push(url);
      assert.ok(Object.hasOwn(routes, url.pathname), `Unexpected request ${url.pathname}`);
      const response = routes[url.pathname]; return response == null ? new Response(null, { status: 404 }) : Response.json(response);
    } });
    const provider = createTmdbPlugin({ client, parseName: (Name) => ({ Name }) }).providers.find((entry) => entry.id === sample.provider);
    const result = await provider[sample.operation](sample.info);
    const expected = native.Cases.find((entry) => entry.Name === sample.name);
    assert.deepEqual(project(result, sample.operation), project(expected.Result, sample.operation));
    assert.deepEqual(requests.map(requestShape), expected.Requests.map(requestShape));
  });
});

test('NFO and TMDB SeriesStatus share the actual native alias and enum behavior', () => {
  for (const sample of native.Statuses) {
    assert.equal(parseSeriesStatus(sample.Input), sample.Output, sample.Input);
    const result = parseNfo(`<tvshow><status>${sample.Input}</status></tvshow>`, { type: 'Series' });
    assert.equal(result.Item.Status ?? null, sample.Output, sample.Input);
  }
  for (const sample of native.AirDays) {
    assert.deepEqual(parseAirDays(sample.Input), sample.Output, sample.Input);
    assert.deepEqual(parseNfo(`<tvshow><airs_dayofweek>${sample.Input}</airs_dayofweek></tvshow>`, { type: 'Series' }).Item.AirDays, sample.Output, sample.Input);
  }
});

test('TMDB external identities preserve the native collection and display order rules', () => {
  const registry = new MetadataRegistry(); registry.register(createTmdbPlugin({ client: {} }));
  const discover = (Type, extra = {}) => registry.discover({ item: { Type, ...extra }, kind: 'externalId', includeDisabled: true }).map((provider) => provider.getExternalIdInfo());
  assert.deepEqual(discover('Movie'), [{ Name: 'TheMovieDb', Key: 'Tmdb', Type: 'Movie' }, { Name: 'TheMovieDb', Key: 'TmdbCollection', Type: 'BoxSet' }]);
  assert.deepEqual(discover('BoxSet'), []);
  assert.equal(discover('LiveTvProgram').length, 0); assert.equal(discover('LiveTvProgram', { IsMovie: true }).length, 1);
  const episode = { Type: 'Episode', SeriesProviderIds: { Tmdb: '10' }, SeasonIndexNumber: 2, IndexNumber: 3 };
  assert.deepEqual(tmdbExternalUrls(episode), ['https://www.themoviedb.org/tv/10/season/2/episode/3']);
  assert.deepEqual(tmdbExternalUrls({ ...episode, SeriesDisplayOrder: 'OriginalAirDate' }), tmdbExternalUrls(episode));
  assert.deepEqual(tmdbExternalUrls({ ...episode, SeriesDisplayOrder: 'originalAirDate' }), []);
  assert.deepEqual(tmdbExternalUrls({ ...episode, SeriesDisplayOrder: 'dvd' }), []);
  assert.deepEqual(tmdbExternalUrls({ ...episode, SeasonIndexNumber: null }), []);
  for (const sample of native.ExternalUrls) {
    assert.deepEqual(tmdbExternalUrls({ ...episode, SeriesDisplayOrder: sample.DisplayOrder }), sample.Episode);
    assert.deepEqual(tmdbExternalUrls({ Type: 'Season', SeriesProviderIds: { Tmdb: '10' }, IndexNumber: 2, SeriesDisplayOrder: sample.DisplayOrder }), sample.Season);
  }
  const types = ['Movie', 'Series', 'Season', 'Episode', 'Person', 'BoxSet', 'MusicVideo', 'Trailer'];
  for (const source of native.ExternalIds) {
    const provider = registry.plugins()[0].providers.find((entry) => entry.id === source.Id);
    assert.deepEqual(provider.getExternalIdInfo(), { Name: source.ProviderName, Key: source.Key, Type: source.Type });
    assert.deepEqual(types.filter((type) => provider.itemTypes.includes(type)), source.Supported);
  }
});

test('registry uses native image configuration and full refresh locking independently of metadata', () => {
  const registry = new MetadataRegistry(); registry.register(createTmdbPlugin({ client: {} }));
  const item = { Type: 'Movie', IsLocked: true };
  assert.equal(registry.discover({ item, kind: 'image' }).length, 0);
  assert.equal(registry.discover({ item, kind: 'image', imageRefreshMode: 'FullRefresh' }).length, 1);
  assert.equal(registry.discover({ item: { ...item, IsLocked: false, ExtraType: 'Trailer' }, kind: 'image' }).length, 0);
  for (const kind of ['remote', 'image']) {
    assert.equal(registry.discover({ item: { Type: 'Movie' }, kind, libraryOptions: { TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }] } }).length, 0);
    assert.equal(registry.discover({ item, kind, includeDisabled: true }).length, 1);
  }
  assert.equal(registry.discover({ item, kind: 'externalId' }).length, 2);
});

test('a combined episode with one surviving response keeps null names and cached data unchanged', async () => {
  const remote = { id: 101, name: null, overview: null };
  const client = new TmdbClient({ apiKey: 'fixture-key', fetch: async (value) => {
    const url = new URL(value);
    if (url.pathname.endsWith('/configuration')) return Response.json(inputs.routes['/3/configuration']);
    return url.pathname.endsWith('/episode/1') ? Response.json(remote) : new Response(null, { status: 404 });
  } });
  const provider = createTmdbPlugin({ client }).providers.find((entry) => entry.id === 'TmdbEpisodeProvider');
  const result = await provider.getMetadata({ SeriesProviderIds: { Tmdb: '10' }, IndexNumber: 1, IndexNumberEnd: 2 });
  assert.equal(result.Item.Name, null); assert.equal(result.Item.Overview, null); assert.equal(result.People, null);
  assert.deepEqual(await client.episode(10, 1, 1, undefined, undefined, 'null,en', undefined), remote);
});
