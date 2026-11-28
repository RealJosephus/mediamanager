import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nativeGuid } from '../../src/users/native.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { createTestRuntime } from './runtime.js';

export const metadataMovieId = nativeGuid('60810000000000000000000000000001');
export const existingTmdbId = 701;
export const identifiedTmdbId = 702;
export const posterFiles = ['preferred.png', 'english.png', 'original.png', 'foreign.png'];
export const posterLanguages = ['fr', 'en', null, 'de'];
const emptyId = nativeGuid('00000000000000000000000000000000');
const fixtureMedia = new URL('../fixtures/frozen-av/source.m2ts', import.meta.url);
const credential = 'controlled-fixture';

async function startTmdbFixture(signal) {
  const poster = await readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url));
  const requests = [];
  let origin;
  const images = { posters: posterFiles.map((filename, index) => ({ file_path: '/' + filename,
    width: 9, height: 7, iso_639_1: posterLanguages[index], vote_average: 5 + index, vote_count: 10 + index })),
  backdrops: [], logos: [] };
  const seedMovie = { id: existingTmdbId, title: 'Existing feature', original_title: 'Existing feature',
    release_date: '2018-02-07', overview: 'Existing synopsis', original_language: 'fr', images };
  const selectedMovie = { id: identifiedTmdbId, title: 'Identified feature', original_title: 'Original feature',
    release_date: '2021-02-03', overview: 'Identification changed this synopsis.', original_language: 'fr',
    poster_path: '/preferred.png', imdb_id: 'tt9876543', images };
  const searchResponses = {
    '/3/search/movie': selectedMovie,
    '/3/search/tv': { id: 703, name: 'Identified series', first_air_date: '2019-01-08', overview: 'Series result', poster_path: '/preferred.png' },
    '/3/search/collection': { id: 704, name: 'Identified collection', poster_path: '/preferred.png' },
    '/3/search/person': { id: 705, name: 'Identified person', profile_path: '/preferred.png' },
  };
  const supportedSizes = ['w45', 'w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'h632', 'original'];
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const name = url.pathname;
    const observed = { method: request.method, path: name,
      query: Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'api_key')) };
    requests.push(observed);
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (name.startsWith('/3/') && url.searchParams.get('api_key') !== credential) {
      response.statusCode = 401;
      json({ status_code: 7 });
    } else if (name === '/3/configuration') {
      json({ images: { secure_base_url: origin + '/images/', base_url: origin + '/images/', poster_sizes: supportedSizes,
        backdrop_sizes: supportedSizes, still_sizes: supportedSizes, logo_sizes: supportedSizes, profile_sizes: supportedSizes } });
    } else if (name === '/3/movie/' + existingTmdbId) json(seedMovie);
    else if (name === '/3/movie/' + identifiedTmdbId) json(selectedMovie);
    else if (Object.hasOwn(searchResponses, name)) json({ page: 1, total_pages: 1, total_results: 1, results: [searchResponses[name]] });
    else if (name.startsWith('/images/') && posterFiles.some(filename => name.endsWith('/' + filename))) {
      response.setHeader('Content-Type', 'image/png');
      response.end(poster);
    } else { response.statusCode = 404; json({ status_code: 34 }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening', { signal });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, poster, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export async function createMetadataHttpFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-metadata-http-'));
  let upstream, database, runtime;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [() => runtime?.close(), () => dropPostgresTestDatabase(database), () => upstream?.close(),
      () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Metadata HTTP fixture cleanup failed.');
  });
  upstream = await startTmdbFixture(t.signal);
  const programDataPath = path.join(root, 'program'), config = path.join(root, 'config'), media = path.join(programDataPath, 'movies');
  await mkdir(media, { recursive: true });
  const filename = path.join(media, 'Initial.m2ts');
  await copyFile(fixtureMedia, filename);
  // Keep the initial on-disk media in the instance's existing Local storage root.
  await writeFile(path.join(media, '.ignore'), '*.unmatched');
  database = await createPostgresTestDatabase(null, 'metadata_http');
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: metadataMovieId, ChannelId: emptyId,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Existing feature', CleanName: 'existing feature',
    SortName: 'existing feature', Path: filename, IsMovie: true, MediaType: 'Video', PresentationUniqueKey: idKey(metadataMovieId),
    Data: '{"VideoType":"VideoFile"}', DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }));
  await database.insert('BaseItemProviders', { ItemId: metadataMovieId, ProviderId: 'Tmdb', ProviderValue: String(existingTmdbId) });
  await database.insert('BaseItemProviders', { ItemId: metadataMovieId, ProviderId: 'ObsoleteFixture', ProviderValue: 'clear-on-identify' });
  const storageConfiguration = path.join(root, 'storage.json');
  await writeFile(storageConfiguration, JSON.stringify({
    instances: [{ id: 'fixture-media', type: 'local', config: { root: media, writable: true } }],
    mounts: [{ path: '/fixture-media', instanceId: 'fixture-media', capabilities: { create: true, replace: true, delete: true, mkdir: true, rename: true } }],
    prefixes: [{ identityRoot: media, accessRoot: '/fixture-media', style: process.platform === 'win32' ? 'windows' : 'posix',
      purpose: 'library', returnAccess: 'isolated identification media' }],
  }));
  const errors = [];
  runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: config, storageConfiguration, serverId: 'metadata-http',
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, PreferredMetadataLanguage: 'fr', MetadataCountryCode: 'FR',
      MetadataOptions: [{ ItemType: 'Movie', DisabledImageFetchers: ['TheMovieDb'], MetadataFetcherOrder: ['TheMovieDb'] }] },
    pluginOptions: { options: { tmdb: { apiKey: credential, baseUrl: upstream.origin + '/3/' } } },
    onError: error => errors.push(error) });
  const providerIds = runtime.metadata.registry.plugins().flatMap(plugin => plugin.providers.map(provider => provider.id));
  assert.ok(providerIds.includes('TmdbMovieProvider') && providerIds.includes('TmdbMovieImageProvider'), 'The configured TMDB plugin must actually be registered.');
  const baseUrl = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  const admin = (await runtime.apiKeys.create('metadata HTTP fixture administrator')).AccessToken;
  await runtime.users.createUser({ Name: 'Metadata HTTP Reader', Password: 'fixture-reader-password' });
  const reader = (await runtime.authentication.login({ Username: 'Metadata HTTP Reader', Pw: 'fixture-reader-password' },
    { Client: 'Metadata fixture', Device: 'Isolated', DeviceId: 'metadata-http-reader', Version: '1' }, { remoteEndPoint: '127.0.0.1' })).AccessToken;
  const request = async (route, { method = 'GET', token = admin, body, accept = 'application/json', headers } = {}) => {
    const response = await fetch(baseUrl + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Accept: accept, Connection: 'close', ...headers, ...(token ? { Authorization: `MediaBrowser Token="${token}"` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]) });
    const bytes = Buffer.from(await response.arrayBuffer()), contentType = response.headers.get('content-type');
    return { status: response.status, bytes, contentType, headers: response.headers,
      body: bytes.length && /^application\/(?:problem\+)?json/.test(contentType ?? '') ? JSON.parse(bytes) : undefined };
  };
  return { runtime, database, upstream, request, programDataPath, filename, reader, errors };
}
