import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from '../database/postgres-fixture.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];

test('Trailers retains native binding and failure boundaries without changing PostgreSQL media', {
  skip: !postgresTestConnectionString, timeout: 90000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mediamanager-trailers-')));
  const output = path.join(validationOutputRoot(), 'trailers-' + randomUUID()); await mkdir(output);
  const secrets = new Set([postgresTestConnectionString]);
  const report = { scope: { actualNodeHttp: true, actualPostgres: true, actualNativeHttp: false }, requests: [], cleanup: [] };
  let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const [name, close] of [['runtime', async () => {
      const listeners = runtime?.networkHost.listeners ?? []; await runtime?.close();
      assert.ok(listeners.every(listener => !listener.server.listening));
    }], ['postgres', () => dropPostgresTestDatabase(database)], ['private-root', async () => {
      assert.equal(path.dirname(root), await realpath(tmpdir()));
      assert.ok(path.basename(root).startsWith('mediamanager-trailers-'));
      await rm(root, { recursive: true });
    }]]) try { await close(); report.cleanup.push({ name, closed: true }); }
    catch (error) { failures.push(error); report.cleanup.push({ name, closed: false, message: error?.message }); }
    await writeFile(path.join(output, 'report.json'), filterEvidenceJson(report, secrets), { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'Trailer HTTP fixture owners failed to close.', { cause: failures[0] });
  });
  database = await createPostgresTestDatabase(null, 'trailers_http');
  runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'program'),
    configurationDirectoryPath: path.join(root, 'config'), configuration: {
      IsStartupWizardCompleted: true, UICulture: 'en-US', EnableGroupingMoviesIntoCollections: false,
    }, serverId: idKey(randomUUID()) });
  const password = randomUUID(); secrets.add(password);
  const users = {}, tokens = {};
  for (const [name, administrator] of [['admin', true], ['reader', false]]) {
    const created = await runtime.users.createUser({ Name: 'Trailers ' + name, Password: password });
    const current = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(current.Id, { ...current.Policy, IsAdministrator: administrator,
      EnableAllFolders: true, BlockedTags: administrator ? [] : ['hidden'] });
    users[name] = await runtime.users.getUser(current.Id);
    const login = await runtime.authentication.login({ Username: users[name].Username, Pw: password }, {
      Client: 'Trailer consumer', Device: 'Isolated', DeviceId: 'trailers-' + name, Version: '1',
    }, { remoteEndPoint: '127.0.0.1' });
    tokens[name] = login.AccessToken; secrets.add(tokens[name]);
  }
  tokens.apiKey = (await runtime.apiKeys.create('Trailer consumer')).AccessToken; secrets.add(tokens.apiKey);
  const ids = Object.fromEntries(['alpha', 'zeta', 'hidden', 'movie', 'audio'].map(name => [name, nativeGuid(randomUUID())]));
  for (const [name, type, mediaType] of [['alpha', 'Trailer', 'Video'], ['zeta', 'Trailer', 'Video'],
    ['hidden', 'Trailer', 'Video'], ['movie', 'Movies.Movie', 'Video'], ['audio', 'Audio.Audio', 'Audio']]) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: ids[name], Type: 'MediaBrowser.Controller.Entities.' + type, Name: name, CleanName: name, SortName: name,
      MediaType: mediaType, Path: path.join(root, 'media', name + '.mkv'), PresentationUniqueKey: idKey(ids[name]),
      DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
      Tags: name === 'hidden' ? 'hidden' : '', Data: '{"Container":"mkv","FixtureUnknown":{"retained":true}}',
    }));
  }
  const tagId = nativeGuid(randomUUID());
  await database.insert('ItemValues', { ItemValueId: tagId, Type: 4, Value: 'hidden', CleanValue: 'hidden' });
  await database.insert('ItemValuesMap', { ItemId: ids.hidden, ItemValueId: tagId });
  const persistedItems = () => database.rows('BaseItems', { whereIn: { Id: Object.values(ids) },
    orderBy: [{ column: 'Id', direction: 'ASC' }] });
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const request = async (route, identity = 'admin') => {
    const response = await fetch(origin + route, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Accept: 'application/json', ...(tokens[identity] ? { Authorization: `MediaBrowser Token="${tokens[identity]}"` } : {}) } });
    const body = await response.text();
    const observation = { route, identity, status: response.status, contentType: response.headers.get('content-type'),
      bodyText: body, ...(response.headers.get('content-type')?.includes('json') && body ? { body: JSON.parse(body) } : {}) };
    report.requests.push(observation); return observation;
  };
  const scope = 'ids=' + Object.values(ids).map(idKey).join(',') + '&sortBy=SortName&fields=Overview,ProviderIds';
  const all = await request('/Items?' + scope + '&includeItemTypes=Trailer'); assert.equal(all.status, 200);
  assert.deepEqual(all.body.Items.map(item => item.Id), ['alpha', 'hidden', 'zeta'].map(name => idKey(ids[name])));
  assert.ok(all.body.Items.every(item => item.Type === 'Trailer'));
  const unbound = '&notAParameter=invalid&isFolder=invalid&minIndexNumber=invalid&linkedChildAncestorIds=invalid';
  const ignored = await request('/Items?' + scope + '&includeItemTypes=Trailer' + unbound);
  assert.deepEqual(ignored.body, all.body);
  const legacy = await request('/Users/' + users.admin.Id + '/Items?' + scope + '&includeItemTypes=Trailer'
    + unbound + '&indexNumber=invalid&audioLanguages=eng&subtitleLanguages=zho');
  assert.deepEqual(legacy.body, all.body);
  assert.equal((await request('/Items?' + scope + '&includeItemTypes=Trailer&indexNumber=invalid' + unbound)).status, 400);
  const resume = await request('/UserItems/Resume?includeItemTypes=Trailer&limit=1');
  assert.equal(resume.status, 200);
  for (const route of ['/UserItems/Resume', '/Users/' + users.admin.Id + '/Items/Resume']) {
    const observed = await request(route + '?includeItemTypes=Trailer&limit=1' + unbound
      + '&recursive=invalid&indexNumber=invalid&isFavorite=invalid&sortBy=invalid&years=invalid');
    assert.equal(observed.status, 200); assert.deepEqual(observed.body, resume.body);
  }
  const page = await request('/Items?' + scope + '&includeItemTypes=Trailer&startIndex=1&limit=1');
  assert.deepEqual(page.body.Items.map(item => item.Id), [idKey(ids.hidden)]); assert.equal(page.body.TotalRecordCount, 3);
  const reader = await request('/Items?' + scope + '&includeItemTypes=Trailer', 'reader');
  assert.deepEqual(reader.body.Items.map(item => item.Id), ['alpha', 'zeta'].map(name => idKey(ids[name])));
  const before = await persistedItems(), allRowsBefore = await database.rows('BaseItems');
  for (const [identity, suffix] of [['admin', ''], ['reader', ''], ['apiKey', ''],
    ['admin', '&IncludeItemTypes=Movie&includeitemtypes=Audio&indexNumber=invalid&hasChapterImages=true'],
    ['admin', '&startIndex=-1&limit=-2&sortBy=Name&sortOrder=Ascending,Descending'],
    ['reader', '&userId=' + idKey(users.admin.Id)], ['admin', '&userId=' + idKey(randomUUID())],
    ['admin', '&artists=Uncreated%20artist&studios=Uncreated%20studio']]) {
    const failed = await request('/Trailers?' + scope + suffix, identity);
    assert.equal(failed.status, 500); assert.equal(failed.contentType, 'text/plain');
    assert.equal(failed.bodyText, 'Error processing request.');
  }
  assert.equal((await request('/Trailers?' + scope + '&enableImages=invalid')).status, 400);
  assert.equal((await request('/Trailers?enableTotalRecordCount=')).status, 400);
  assert.equal((await request('/Trailers?limit=invalid', 'anonymous')).status, 401);
  assert.deepEqual(await persistedItems(), before);
  assert.deepEqual(await database.rows('BaseItems'), allRowsBefore);
  report.seededMediaRowsUnchanged = true;
});
