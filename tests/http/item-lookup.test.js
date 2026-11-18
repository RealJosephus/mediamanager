import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createMetadataHttpFixture, identifiedTmdbId, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('item lookup follows the public identify contract through runtime TMDB, metadata refresh and PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const { database, runtime, upstream, request, reader, errors } = await createMetadataHttpFixture(t);
  const id = idKey(metadataMovieId), result = { requests: {} };
  t.after(() => writeFile(path.join(validationOutputRoot(), 'item-lookup-' + randomUUID() + '.json'),
    JSON.stringify({ ...result, upstream: upstream.requests, errors: errors.map(error => ({ name: error?.name, code: error?.code,
      message: error?.message })) }, null, 2)));
  const probe = async (name, route, options) => {
    const response = await request(route, options);
    result.requests[name] = { status: response.status, body: response.body ?? response.bytes.toString(), contentType: response.contentType };
    return response;
  };
  const externalIds = `/Items/${id}/ExternalIdInfos`;
  const empty = '00000000000000000000000000000000';
  assert.equal((await probe('anonymous external identities', externalIds, { token: null })).status, 401);
  assert.equal((await probe('ordinary external identities', externalIds, { token: reader })).status, 403);
  const ids = await probe('external identities', externalIds);
  assert.equal(ids.status, 200);
  assert.deepEqual(ids.body, [{ Name: 'IMDb', Key: 'Imdb' }, { Name: 'TheMovieDb', Key: 'Tmdb', Type: 'Movie' },
    { Name: 'TheMovieDb', Key: 'TmdbCollection', Type: 'BoxSet' }]);
  assert.equal((await probe('empty external identity item', externalIds.replace(id, empty))).status, 400);
  const search = (type, body, token) => probe(`search ${type}`, `/Items/RemoteSearch/${type}`, { method: 'POST', body, token });
  const body = { SearchInfo: { Name: 'Title to identify', Year: '2021' }, ItemId: id, SearchProviderName: 'themoviedb' };
  const movie = await search('Movie', body, reader);
  assert.equal(movie.status, 200);
  assert.equal(movie.body.length, 1);
  assert.deepEqual(movie.body[0], { Name: 'Identified feature', ProviderIds: { Tmdb: String(identifiedTmdbId) },
    ProductionYear: 2021, PremiereDate: '2021-02-03T00:00:00.000Z', ImageUrl: upstream.origin + '/images/original/preferred.png',
    SearchProviderName: 'TheMovieDb', Overview: 'Identification changed this synopsis.', Artists: [] });
  const camel = await probe('camel-case search result', '/Items/RemoteSearch/Movie', { method: 'POST', body, token: reader,
    accept: 'application/json; profile="CamelCase"' });
  assert.equal(camel.status, 200);
  assert.deepEqual(camel.body[0].providerIds, { Tmdb: String(identifiedTmdbId) });
  const sampleSearch = { SearchInfo: { Name: 'web search sample' }, IncludeDisabledProviders: true };
  for (const [type, name, providerId] of [['Series', 'Identified series', '703'], ['BoxSet', 'Identified collection', '704'],
    ['Person', 'Identified person', '705']]) {
    if (type === 'Person') assert.equal((await search(type, sampleSearch, reader)).status, 403);
    const response = await search(type, sampleSearch);
    assert.equal(response.status, 200);
    assert.equal(response.body[0].Name, name);
    assert.deepEqual(response.body[0].ProviderIds, { Tmdb: providerId });
  }
  for (const type of ['Trailer', 'MusicVideo', 'MusicArtist', 'MusicAlbum', 'Book']) {
    const response = await search(type, sampleSearch);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [], `No scoped remote provider is configured for ${type}`);
  }
  const invalid = await probe('malformed search year', '/Items/RemoteSearch/Movie', { method: 'POST', body: { SearchInfo: { Year: 'invalid' } } });
  assert.equal(invalid.status, 400);
  const applyPath = `/Items/RemoteSearch/Apply/${id}?replaceAllImages=false`;
  const selected = movie.body[0];
  assert.equal((await probe('ordinary apply', applyPath, { method: 'POST', body: selected, token: reader })).status, 403);
  assert.equal((await probe('apply empty item', applyPath.replace(id, empty), { method: 'POST', body: selected })).status, 400);
  assert.equal((await probe('apply missing item', applyPath.replace(id, '73a50000000000000000000000000000'), { method: 'POST', body: selected })).status, 404);
  const response = await probe('apply selected movie', applyPath, { method: 'POST', body: selected });
  assert.equal(response.status, 204, errors.map(error => error.message).join('\n') || response.bytes.toString());
  const rows = await database.rows('BaseItemProviders', { where: { ItemId: metadataMovieId } });
  const committed = await probe('applied item readback', `/Items/${id}`, { token: reader });
  assert.equal(committed.status, 200);
  result.applied = { name: committed.body.Name, overview: committed.body.Overview, providerIds: committed.body.ProviderIds,
    persistentProviderIds: Object.fromEntries(rows.map(({ ProviderId, ProviderValue }) => [ProviderId, ProviderValue])) };
  assert.deepEqual(result.applied, { name: 'Identified feature', overview: 'Identification changed this synopsis.',
    providerIds: { Tmdb: '702', Imdb: 'tt9876543' }, persistentProviderIds: { Tmdb: '702', Imdb: 'tt9876543' } });
  assert.equal((await runtime.library.getItemRecord(id)).ProductionYear, 2021);
  assert.ok(upstream.requests.some(entry => entry.path === '/3/search/movie' && entry.query.language === 'fr'));
  assert.ok(upstream.requests.some(entry => entry.path === '/3/movie/' + identifiedTmdbId));
});
