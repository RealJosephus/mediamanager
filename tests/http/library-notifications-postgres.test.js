import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { createTestApplication } from '../helpers/application.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const movie = 'MediaBrowser.Controller.Entities.Movies.Movie', series = 'MediaBrowser.Controller.Entities.TV.Series';
const fixtureId = value => '0a9d0700-2241-472e-8307-' + String(value).padStart(12, '0');

test('library notifications report ordered provider matches and explicit paths through the installed monitor', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'library_notif');
  const store = new DomainStore(database), reported = [];
  let application;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(async () => {
      application?.beginClose(); await application?.drainRequests();
      if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    });
    await attempt(() => store.close());
    await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Library notification fixture cleanup failed.');
  });
  await store.run(session => session.transaction(async () => {
    let position = 0;
    const create = async (ordinal, Type, Path, providers, options = {}) => {
      const Id = fixtureId(ordinal);
      await session.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type, Path, Name: Path,
        SortName: String(++position).padStart(4, '0'), Data: '{}', IsFolder: Type === series, ...options }));
      for (const [ProviderId, ProviderValue] of providers) await session.insert('BaseItemProviders', { ItemId: Id, ProviderId, ProviderValue });
    };
    for (let ordinal = 300; ordinal > 43; ordinal--) await create(ordinal, series, `/series/${ordinal}`, [['tvDb', 'EpIsoDes']]);
    await create(1, series, '/series/without-tvdb', [['Imdb', 'tt-show']]);
    await create(2, series, '/series/empty-tvdb', [['Tvdb', '']]);
    await create(3, movie, '/movies/imdb', [['ImDb', 'TT-EXACT'], ['Tmdb', '11']]);
    await create(4, movie, '/movies/tmdb', [['Tmdb', '22']]);
    await create(5, movie, '/movies/wrong-kind', [['Tvdb', 'EpIsoDes']]);
    await create(6, movie, '/movies/owned-non-extra', [['Tmdb', '22']], { OwnerId: fixtureId(4) });
    await create(7, movie, '/movies/same-library-alternate', [['Tmdb', '22']], { PrimaryVersionId: fixtureId(4) });
    await create(8, movie, '/movies/other-library-alternate', [['Tmdb', '22']], {
      PrimaryVersionId: fixtureId(4), TopParentId: fixtureId(1), SortName: '0000',
    });
    await create(9, movie, '/movies/owned-extra', [['Tmdb', '22']], { OwnerId: fixtureId(4), ExtraType: 1 });
  }));
  const authentication = new AuthenticationService({ store, users: {}, serverId: 'library-notifications', isLocalNetwork: () => true });
  authentication.authenticate = async request => ({ IsAuthenticated: request.headers['x-user'] !== 'anonymous',
    User: { Policy: { EnableRemoteAccess: true }, AccessSchedules: [] } });
  application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, store,
    libraryMonitor: { reportFileSystemChanged: async path => { reported.push(path); } } });
  await new Promise((resolve, reject) => application.server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const origin = 'http://127.0.0.1:' + application.server.address().port;
  const post = async (route, body, user = 'regular') => {
    const response = await fetch(origin + '/Library' + route, { method: 'POST', signal: t.signal,
      headers: { 'X-User': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await response.text();
    return response.status;
  };
  const selected = Array.from({ length: 257 }, (_, index) => '/series/' + (300 - index));
  assert.equal(await post('/Series/Added?tvdbId=episodes'), 204);
  assert.deepEqual(reported.splice(0), selected);
  assert.equal(await post('/Series/Updated'), 204);
  assert.deepEqual(reported.splice(0), ['/series/without-tvdb', '/series/empty-tvdb']);
  assert.equal(await post('/Movies/Added?tmdbId=22&imdbId=tt-exact'), 204);
  assert.deepEqual(reported.splice(0), ['/movies/imdb']);
  assert.equal(await post('/Movies/Updated?tmdbId=22&imdbId=%20'), 204);
  assert.deepEqual(reported.splice(0), ['/movies/other-library-alternate', '/movies/tmdb', '/movies/owned-extra']);
  assert.equal(await post('/Movies/Updated?imdbId=unknown&tmdbId=22'), 204);
  assert.deepEqual(reported, []);
  assert.equal(await post('/Media/Updated', { Updates: [{ Path: '/explicit/first', UpdateType: 'Deleted' },
    { Path: '/explicit/second', UpdateType: 'Created' }, { Path: '/explicit/first', UpdateType: 'Modified' }] }), 204);
  assert.deepEqual(reported.splice(0), ['/explicit/first', '/explicit/second', '/explicit/first']);
  assert.equal(await post('/Media/Updated', { Updates: [{ Path: '/prefix-committed' }, {}] }), 400);
  assert.deepEqual(reported.splice(0), ['/prefix-committed']);
  assert.equal(await post('/Media/Updated', { Updates: null }), 400);
  assert.equal(await post('/Media/Updated', { Updates: [{ Path: '/denied' }] }, 'anonymous'), 401);
  assert.deepEqual(reported, []);
});
