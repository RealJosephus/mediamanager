import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { cleanValue } from '../../src/library/records.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const ids = {
  plain: '72000000-0000-0000-0000-000000000001',
  subtitle: '72000000-0000-0000-0000-000000000002',
  audio: '72000000-0000-0000-0000-000000000003',
};

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns
    .filter(column => !column.generated)
    .map(column => [column.name, column.nullable ? null
      : column.clrType === 'bool' ? false
        : column.type === 'TEXT' ? ''
          : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}

function movie(id, name) {
  return {
    ...emptyRow('BaseItems'),
    Id: id,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: name,
    CleanName: cleanValue(name),
    SortName: cleanValue(name),
    PresentationUniqueKey: id,
    IsMovie: true,
    MediaType: 'Video',
    UnratedType: 'Movie',
    Path: `Z:\\StreamFilterLoading\\${name}.mkv`,
    DateCreated: '2026-09-28 00:00:00',
    DateModified: '2026-09-28 00:00:00',
    DateLastSaved: '2026-09-28 00:00:00',
    Data: '{"VideoType":"VideoFile"}',
  };
}

function authorization(token) {
  return `MediaBrowser Client="StreamFilterLoading", Device="Isolated", DeviceId="stream-filter-loading", Version="1"${token ? `, Token="${token}"` : ''}`;
}

test('Items routes filter streams in PostgreSQL without hydrating candidate streams',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const prefix = path.join(tmpdir(), 'mediamanager-stream-filter-loading-');
  const programDataPath = await mkdtemp(prefix);
  const mediaStreamReads = [];
  let database, runtime;
  try {
    database = await createPostgresTestDatabase(t, 'stream_filter_loading');
    const originalRows = database.rows.bind(database);
    database.rows = async (name, options) => {
      const rows = await originalRows(name, options);
      if (name === 'MediaStreamInfos') {
        mediaStreamReads.push({
          options: structuredClone(options ?? {}),
          rows: structuredClone(rows),
        });
      }
      return rows;
    };
    runtime = await createTestRuntime({
      database,
      configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
      serverId: 'stream-filter-loading',
      serverName: 'Stream Filter Loading Test',
      programDataPath,
    });
    const created = await runtime.users.createUser({ Name: 'StreamAdmin', Password: 'stream password' });
    const current = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(created.Id, { ...current.Policy, IsAdministrator: true, EnableAllFolders: true });

    for (const [key, id] of Object.entries(ids)) await database.insert('BaseItems', movie(id, key));
    await database.insert('MediaStreamInfos', {
      ...emptyRow('MediaStreamInfos'), ItemId: ids.subtitle, StreamIndex: 0, StreamType: 2, Language: 'eng',
    });
    await database.insert('MediaStreamInfos', {
      ...emptyRow('MediaStreamInfos'), ItemId: ids.audio, StreamIndex: 0, StreamType: 0, Language: 'fre',
    });
    // This irrelevant type proves that each filtered read is constrained in the database,
    // rather than loading the table and discarding video rows in JavaScript.
    await database.insert('MediaStreamInfos', {
      ...emptyRow('MediaStreamInfos'), ItemId: ids.plain, StreamIndex: 0, StreamType: 1, Language: 'zxx',
    });
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
    const request = async (route, { method = 'GET', token, body } = {}) => {
      const response = await fetch(origin + route, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: authorization(token),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const login = await request('/Users/AuthenticateByName', {
      method: 'POST', body: { Username: 'StreamAdmin', Pw: 'stream password' },
    });
    assert.equal(login.status, 200);
    const token = login.body.AccessToken;
    const userId = login.body.User.Id;
    const common = `Ids=${encodeURIComponent(Object.values(ids).join(','))}&Recursive=true&EnableImages=false&EnableUserData=false`;

    const run = async (route, expectedNames) => {
      mediaStreamReads.length = 0;
      const response = await request(`${route}${route.includes('?') ? '&' : '?'}${common}`, { token });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.Items.map(item => item.Name).sort(), expectedNames);
      assert.equal(response.body.TotalRecordCount, expectedNames.length);
      assert.deepEqual(mediaStreamReads, [], 'stream filters stay in SQL before DTO hydration');
    };
    await run('/Items', ['audio', 'plain', 'subtitle']);
    await run('/Items?HasSubtitles=true', ['subtitle']);
    await run('/Items?SubtitleLanguages=eng', ['subtitle']);
    await run('/Items?AudioLanguages=fre', ['audio']);
    await run('/Items?SubtitleLanguages=eng&AudioLanguages=fre', []);

    // The obsolete user-scoped action never bound either language parameter.
    await run(`/Users/${userId}/Items?SubtitleLanguages=eng&AudioLanguages=fre`, ['audio', 'plain', 'subtitle']);
    // HasSubtitles is public on both actions, so legacy must retain it while discarding the language.
    await run(`/Users/${userId}/Items?HasSubtitles=true&SubtitleLanguages=fre`, ['subtitle']);
  } finally {
    try {
      if (runtime) await runtime.close();
    } finally {
      assert.ok(path.resolve(programDataPath).startsWith(path.resolve(prefix)));
      await rm(programDataPath, { recursive: true });
    }
  }
});
