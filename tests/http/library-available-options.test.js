import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { SimilarItemsManager } from '../../src/library/similar-items.js';
import { hasFileProtocol } from '../../src/library/delete-permission.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { createTestApplication } from '../helpers/application.js';

test('available library options reflect active extensions, content types and new-library defaults', async t => {
  const configuration = { IsStartupWizardCompleted: true, MetadataOptions: [{ ItemType: 'mOvIe',
    DisabledMetadataSavers: ['nfo'], DisabledMetadataFetchers: ['THEMOVIEDB'], DisabledImageFetchers: ['local artwork'] }] };
  const registry = new MetadataRegistry();
  registry.register({ id: 'providers', name: 'Active providers', providers: [
    { id: 'nfo-reader', name: 'Nfo', kind: 'local', itemTypes: ['Movie', 'Episode'] },
    { id: 'nfo-saver', name: 'Nfo', kind: 'saver', itemTypes: ['Movie', 'Episode'] },
    { id: 'tmdb', name: 'TheMovieDb', kind: 'remote', itemTypes: ['Movie', 'Series', 'Season', 'Episode'] },
    { id: 'tmdb-image', name: 'TheMovieDb', kind: 'image', imageSource: 'remote', itemTypes: ['Movie', 'Series'], order: 1,
      imageTypes: ['Primary', 'Backdrop', 'Logo'] },
    { id: 'local-image', name: 'Local Artwork', kind: 'image', imageSource: 'dynamic', itemTypes: ['Movie'], order: 2,
      imageTypesFor: async item => hasFileProtocol(item) ? ['Primary', 'Thumb'] : [] },
  ] });
  registry.register({ id: 'unavailable', name: 'Disabled providers', enabled: false, providers: [
    { id: 'disabled-search', name: 'Disabled provider', kind: 'remote', itemTypes: ['Movie'] },
  ] });
  const similarItems = new SimilarItemsManager({ providers: [{ name: 'TheMovieDb', kind: 'remote', itemTypes: ['Movie', 'Series'] }] });
  const extensions = { subtitle: [{ name: 'Subtitles', supportedMediaTypes: ['Episode'] }], lyric: [{ name: 'Lyrics' }] };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'library-options', isLocalNetwork: () => true });
  authentication.authenticate = async request => ({ IsAuthenticated: request.headers['x-user'] !== 'anonymous',
    User: { Policy: { EnableRemoteAccess: true }, AccessSchedules: [] } });
  const application = await createTestApplication({ configuration, metadata: { registry }, similarItems, authentication,
    plugins: { entries: kind => extensions[kind] ?? [], bind: async () => {} } });
  t.after(async () => {
    application.beginClose(); await application.drainRequests();
    if (application.server.listening) await new Promise(resolve => application.server.close(resolve));
  });
  await new Promise((resolve, reject) => application.server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const origin = 'http://127.0.0.1:' + application.server.address().port;
  const get = async (query = '', user = 'regular') => {
    const response = await fetch(origin + '/Libraries/AvailableOptions' + query, { signal: t.signal, headers: { 'X-User': user } });
    const value = await response.text();
    return { status: response.status, body: response.ok ? JSON.parse(value) : value };
  };
  const names = (Name, DefaultEnabled) => ({ Name, DefaultEnabled });
  const movies = (await get('?libraryContentType=1')).body;
  assert.deepEqual(movies.MetadataReaders, [names('Nfo', true)]);
  assert.deepEqual(movies.MetadataSavers, [names('Nfo', false)]);
  assert.deepEqual(movies.SubtitleFetchers, []);
  assert.deepEqual(movies.LyricFetchers, []);
  assert.deepEqual(movies.MediaSegmentProviders, []);
  const movie = movies.TypeOptions[0];
  assert.equal(movies.TypeOptions.length, 1);
  assert.equal(movie.Type, 'Movie');
  assert.deepEqual(movie.MetadataFetchers, [names('TheMovieDb', false)]);
  assert.deepEqual(movie.ImageFetchers, [names('TheMovieDb', true), names('Local Artwork', false)]);
  assert.deepEqual(movie.SimilarItemProviders, [names('Local Genre/Tag', true), names('TheMovieDb', false)]);
  assert.deepEqual(movie.SupportedImageTypes, ['Primary', 'Backdrop', 'Logo', 'Thumb']);
  assert.deepEqual(movie.DefaultImageOptions.map(({ Type, Limit, MinWidth }) => [Type, Limit, MinWidth]),
    [['Backdrop', 1, 1280], ['Art', 0, 0], ['Disc', 0, 0], ['Primary', 1, 0], ['Banner', 0, 0], ['Thumb', 1, 0], ['Logo', 1, 0]]);

  const shows = (await get('?libraryContentType=TVShows&isNewLibrary=true')).body;
  assert.deepEqual(shows.TypeOptions.map(type => type.Type), ['Series', 'Season', 'Episode']);
  assert.deepEqual(shows.MetadataSavers, [names('Nfo', false)]);
  assert.deepEqual(shows.SubtitleFetchers, [names('Subtitles', true)]);
  assert.deepEqual(shows.TypeOptions.map(type => type.MetadataFetchers), [[names('TheMovieDb', true)],
    [names('TheMovieDb', false)], [names('TheMovieDb', false)]]);
  assert.deepEqual(shows.TypeOptions[0].ImageFetchers, [names('TheMovieDb', false)]);
  assert.deepEqual((await get('?libraryContentType=books')).body.LyricFetchers, [names('Lyrics', true)]);
  assert.deepEqual((await get('?libraryContentType=invalid')).body.TypeOptions.map(type => type.Type), ['Series', 'Season', 'Episode', 'Movie']);
  assert.equal((await get('?isNewLibrary=invalid')).status, 400);
  assert.equal((await get('', 'anonymous')).status, 401);
  configuration.IsStartupWizardCompleted = false;
  assert.equal((await get('', 'anonymous')).status, 200);
  registry.unregister('providers');
  assert.deepEqual((await get('?libraryContentType=movies')).body.TypeOptions[0].MetadataFetchers, []);
});
