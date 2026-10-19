import test from 'node:test';
import assert from 'node:assert/strict';
import { TmdbClient, TmdbHttpError } from '../../plugins/tmdb/client.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { findBestMatch, mapCast, parentalRating } from '../../plugins/tmdb/utils.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { trySetProviderId } from '../../src/metadata/provider-ids.js';

const configuration = { images: { secure_base_url: 'https://images.invalid/', poster_sizes: ['w500', 'original'], backdrop_sizes: ['w780', 'original'] } };
function fixtureClient(handler, options = {}) {
  const calls = [];
  const client = new TmdbClient({ apiKey: 'fixture-key', fetch: async (value, requestOptions) => {
    const url = new URL(value); calls.push(url);
    if (url.pathname.endsWith('/configuration')) return Response.json(configuration);
    return handler(url, requestOptions);
  }, ...options });
  return { client, calls };
}

test('TMDB client source cache key deliberately reuses raw language across countries', async () => {
  const { client, calls } = fixtureClient((url) => Response.json({ id: 1, title: url.searchParams.get('language') }));
  assert.equal((await client.movie(1, 'es-419', 'es-AR,null,en', 'AR')).title, 'es-AR');
  assert.equal((await client.movie(1, 'es-419', 'es-MX,null,en', 'MX')).title, 'es-AR');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get('append_to_response'), 'credits,releases,images,videos,keywords');
});

test('TMDB only caches nonempty search pages and expires details after one hour', async () => {
  let now = 0; let searchCount = 0;
  const { client, calls } = fixtureClient((url) => {
    if (url.pathname.includes('/search/')) { searchCount++; return Response.json({ results: [] }); }
    return Response.json({ id: 2 });
  }, { now: () => now });
  await client.search('Movie', 'Nothing', 2020, 'en', 'US'); await client.search('Movie', 'Nothing', 2020, 'en', 'US');
  assert.equal(searchCount, 2);
  await client.movie(2, 'en', null, 'US'); await client.movie(2, 'en', null, 'US');
  now = 3_600_000; await client.movie(2, 'en', null, 'US');
  assert.equal(calls.filter((url) => url.pathname.endsWith('/movie/2')).length, 2);
});

test('TMDB returns missing detail as null while rate limits remain errors', async () => {
  const { client } = fixtureClient((url) => url.pathname.endsWith('/1') ? new Response(null, { status: 404 }) : new Response(null, { status: 429, headers: { 'retry-after': '3' } }));
  assert.equal(await client.movie(1, 'en', null, 'US'), null);
  await assert.rejects(client.movie(2, 'en', null, 'US'), (error) => error instanceof TmdbHttpError && error.status === 429 && error.retryAfter === '3' && !error.message.includes('fixture-key'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.movie(3, 'en', null, 'US', { signal: controller.signal }), { name: 'AbortError' });
});

test('TMDB missing/error responses release their network bodies', async () => {
  const cancelled = [];
  const { client } = fixtureClient((url) => {
    const status = url.pathname.endsWith('/1') ? 404 : 429;
    return new Response(new ReadableStream({ cancel() { cancelled.push(status); } }), { status });
  });
  assert.equal(await client.movie(1, 'en', null, 'US'), null);
  await assert.rejects(client.movie(2, 'en', null, 'US'), { status: 429 });
  assert.deepEqual(cancelled, [404, 429]);
});

test('TMDB image configuration invalid preferences and localized backdrops follow source', async () => {
  const { client } = fixtureClient(() => Response.json({}), { configuration: { PosterSize: '', BackdropSize: 'w780' } });
  await client.getClientConfiguration();
  assert.equal(client.configuration.PosterSize, 'original');
  const images = client.convertImages([{ file_path: '/p.jpg', iso_639_1: 'en', width: 1920, height: 1080, vote_average: 8, vote_count: 2 }], 'Backdrop', 'en-US');
  assert.equal(images[0].Type, 'Thumb'); assert.equal(images[0].Language, 'en-US');
  assert.equal(images[0].Width, null); assert.equal(images[0].Url, 'https://images.invalid/w780/p.jpg');
});

test('TMDB group order changes requested physical episode but preserves display-order cache identity', async () => {
  const { client, calls } = fixtureClient((url) => {
    if (url.pathname.endsWith('/tv/1')) return Response.json({ episode_groups: { results: [{ type: 3, id: 'dvd-group' }] } });
    if (url.pathname.includes('/episode_group/')) return Response.json({ groups: [{ order: 2, episodes: [{ order: 0, season_number: 3, episode_number: 4 }] }] });
    return Response.json({ id: 99 });
  });
  const result = await client.episode(1, 2, 1, 'dvd', 'en', 'en,null', 'US');
  assert.equal(result.id, 99); assert.equal(calls.at(-1).pathname, '/3/tv/1/season/3/episode/4');
});

test('TMDB match scores title before year, keeps ties and maps aggregate cast roles', () => {
  const results = [{ title: 'Mulan', release_date: '1998-01-01' }, { title: 'Mulan', release_date: '2020-01-01' }];
  assert.equal(findBestMatch(results, 'Mulan', 2020), results[1]);
  assert.equal(findBestMatch(results, 'Mulan', 0), results[0]);
  const cast = mapCast([{ id: 2, name: ' A ', order: 0, roles: [{ character: 'Short', episode_count: 1 }, { character: 'Long', episode_count: 10 }] }], tmdbConfiguration(), () => null, true);
  assert.deepEqual(cast.map((person) => person.Role), ['Long', 'Short']);
  assert.equal(parentalRating('DE', '12'), 'FSK-12');
});

test('TMDB movie identification uses baseline name parsing and maps fixed remote fields', async () => {
  const remote = { id: 99, title: 'Movie', original_title: 'Original', overview: 'A\n\nB', imdb_id: 'tt1234567', release_date: '2020-01-02', vote_average: 8.1,
    releases: { countries: [{ iso_3166_1: 'DE', certification: '12' }] }, belongs_to_collection: { id: 5, name: 'Collection' },
    credits: { cast: [{ name: '', order: 0 }, { name: 'Actor', order: 1, id: 3 }], crew: [] }, videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'T' }] } };
  const { client, calls } = fixtureClient(url => Response.json(url.pathname.includes('/search/') ? { results: [remote] } : remote), { configuration: { MaxCastMembers: 1 } });
  const plugin = createTmdbPlugin({ client }); const provider = plugin.providers.find((entry) => entry.id === 'TmdbMovieProvider');
  const identified = await provider.getMetadata({ Name: 'Movie (2020)', ProviderIds: {}, MetadataLanguage: 'en', MetadataCountryCode: 'DE' });
  assert.equal(identified.HasMetadata, true); assert.equal(identified.Item.ProviderIds.Tmdb, '99');
  assert.equal(calls.find(url => url.pathname.includes('/search/')).searchParams.get('query'), 'Movie');
  const result = await provider.getMetadata({ ProviderIds: { Tmdb: '99' }, MetadataLanguage: 'en', MetadataCountryCode: 'DE' });
  assert.equal(result.Item.OfficialRating, 'FSK-12'); assert.equal(result.Item.Overview, 'A\nB');
  assert.equal(result.Item.ProviderIds.TmdbCollection, '5'); assert.equal(result.Item.TmdbCollectionName, 'Collection');
  assert.equal(result.People.length, 0);
});

test('TMDB person keeps incoming name and season search is empty without a request', async () => {
  const { client } = fixtureClient(() => Response.json({ id: 2, name: 'Remote Name', biography: 'Bio', birthday: '1970-01-01' }));
  const plugin = createTmdbPlugin({ client });
  const person = plugin.providers.find((entry) => entry.id === 'TmdbPersonProvider');
  assert.equal((await person.getMetadata({ Name: 'Incoming Name', ProviderIds: { Tmdb: '2' }, MetadataLanguage: 'en' })).Item.Name, 'Incoming Name');
  const season = plugin.providers.find((entry) => entry.id === 'TmdbSeasonProvider');
  assert.deepEqual(await season.search({}), []);
  assert.equal((await season.getMetadata({})).HasMetadata, false);
});

test('metadata registry separates local and remote capabilities and explicit includeDisabled', () => {
  const registry = new MetadataRegistry();
  registry.register({ id: 'fixture', name: 'Fixture', providers: [
    { id: 'local', name: 'Nfo', kind: 'local', itemTypes: ['Movie'] },
    { id: 'remote', name: 'TheMovieDb', kind: 'remote', itemTypes: ['Movie'], order: 1 },
  ] });
  assert.throws(() => registry.register({ id: 'fixture', name: 'Fixture', providers: [] }), /already registered/);
  assert.deepEqual(registry.discover({ item: { Type: 'Movie', IsLocked: true } }).map((entry) => entry.id), ['local']);
  assert.equal(registry.discover({ item: { Type: 'Movie', IsLocked: true }, includeDisabled: true }).length, 2);
  assert.equal(registry.discover({ item: { Type: 'Movie', ExtraType: 'Trailer' }, kind: 'remote' }).length, 0);
  assert.equal(registry.discover({ item: { Type: 'Movie' }, kind: 'remote', libraryOptions: { TypeOptions: [{ Type: 'Movie', MetadataFetchers: ['Other'] }] } }).length, 0);
});

test('provider ID normalization rejects invalid known IDs and preserves arbitrary providers', () => {
  const item = { ProviderIds: { Other: 'old' } };
  assert.equal(trySetProviderId(item, 'tmdb', 'tt1234567'), false);
  assert.equal(trySetProviderId(item, ' tmdb ', ' 005 '), true);
  assert.equal(trySetProviderId(item, 'other', 'new'), true);
  assert.equal(trySetProviderId(item, 'a=b', 'x'), false);
  assert.deepEqual(item.ProviderIds, { Other: 'new', Tmdb: '005' });
});
