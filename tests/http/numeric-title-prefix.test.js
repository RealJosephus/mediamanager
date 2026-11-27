import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
export const requiredValidationServices = ['postgres'];

async function fixture(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-catalog-'));
  const database = await createPostgresTestDatabase(null, name);
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); } finally {
      try { await dropPostgresTestDatabase(database); } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'program'),
    configurationDirectoryPath: path.join(root, 'config'), configuration: {
      IsStartupWizardCompleted: true, UICulture: 'en-US', EnableGroupingMoviesIntoCollections: false,
    }, serverId: idKey(randomUUID()) });
  const token = (await runtime.apiKeys.create('Isolated review')).AccessToken;
  const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(item => item.scheme === 'http').port;
  const request = (url, method = 'GET', body) => fetch(origin + url, { method, signal: t.signal,
    headers: { Authorization: 'MediaBrowser Token="' + token + '"', Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { runtime, database, root, request };
}

test('numeric title prefix finds an existing movie by its natural-sort key through HTTP and PostgreSQL', async t => {
  const { database, root, request } = await fixture(t, 'review_title');
  const id = nativeGuid(randomUUID());
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: '21 Jump Street', CleanName: '21 jump street',
    SortName: '0000000021 jump street', MediaType: 'Video', Path: path.join(root, '21 Jump Street.mkv'), PresentationUniqueKey: idKey(id),
    DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
  }));
  const query = '/Items?ids=' + idKey(id) + '&includeItemTypes=Movie';
  const ids = async address => {
    const response = await request(address);
    assert.equal(response.status, 200);
    return (await response.json()).Items.map(item => item.Id);
  };
  assert.deepEqual(await ids(query), [idKey(id)]);
  for (const prefix of ['21', '2', '21 jump', '0000000021']) {
    assert.deepEqual(await ids(query + '&nameStartsWith=' + encodeURIComponent(prefix)), [idKey(id)], prefix);
  }
  assert.deepEqual(await ids(query + '&nameStartsWith=22'), []);
  assert.deepEqual(await ids(query + '&nameStartsWithOrGreater=21&nameLessThan=22'), [idKey(id)]);
  assert.deepEqual(await ids(query + '&nameStartsWithOrGreater=22'), []);
  assert.deepEqual(await ids(query + '&nameLessThan=20'), []);

  const bounds = [];
  for (const name of ['Hotel Nonmanual', 'Solo Movie', 'Zulu Shared Collection']) {
    const movieId = nativeGuid(randomUUID());
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: movieId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: name, SortName: name.toLowerCase(),
      MediaType: 'Video', Path: path.join(root, name + '.mkv'), PresentationUniqueKey: idKey(movieId),
      DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
    }));
    bounds.push(idKey(movieId));
  }
  const range = '/Items?ids=' + bounds.join(',') + '&sortBy=SortName';
  assert.deepEqual(await ids(range), bounds);
  const unicodeBounds = new URLSearchParams({ nameStartsWithOrGreater: 'İ', nameLessThan: 'ẞ' });
  assert.deepEqual(await ids(range + '&' + unicodeBounds), [bounds[1]]);
});
