import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { loadLocalizationData } from '../../src/core/localization-data.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const ids = {
  root: '65000000-0000-0000-0000-000000000001',
  collection: '65000000-0000-0000-0000-000000000002',
  folder: '65000000-0000-0000-0000-000000000003',
  movie: '65000000-0000-0000-0000-000000000004',
  hidden: '65000000-0000-0000-0000-000000000005',
  unknown: '65000000-0000-0000-0000-000000000006',
  virtual: '65000000-0000-0000-0000-000000000007',
  missing: '65000000-0000-0000-0000-000000000099'
};

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
}

function item(Id, Type, values = {}) {
  const className = Type.split('.').at(-1);
  return { ...blank('BaseItems'), Id, Type: Type.startsWith('MediaBrowser.Controller.Entities.') || Type.startsWith('Plugin.')
    ? Type : `MediaBrowser.Controller.Entities.${Type}`,
    Name: className, CleanName: className.toLowerCase(), SortName: className.toLowerCase(), MediaType: 'Unknown',
    Data: '{}', ...values };
}

async function dropPostgresSchema(connectionString, schema) {
  const cleanup = await PostgresDatabase.open({ connectionString, schema });
  try {
    await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
  } finally {
    await cleanup.close();
  }
}

function authorization(token) {
  return `MediaBrowser Client="MetadataEditorTest", Device="Test Device", DeviceId="metadata-editor-device", Version="1", Token="${token}"`;
}

test('PostgreSQL: metadata editor service and HTTP route preserve the elevated read-only contract', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `metadata_editor_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const configuration = {
    UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true,
    ContentTypes: [{ Name: 'Z:\\MetadataEditor', Value: 'tvshows' }]
  };
  const runtime = await createTestRuntime({ database, configuration, serverId: 'metadata-editor-service-test' });
  try {
    await database.insert('BaseItems', item(ids.root, 'UserRootFolder', { Name: 'Media Folders', IsFolder: true }));
    await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', {
      Name: 'Movies', IsFolder: true, ParentId: ids.root,
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.folder], PhysicalLocationsList: ['Z:\\MetadataEditor'] })
    }));
    await database.insert('BaseItems', item(ids.folder, 'Folder', {
      Name: 'Physical Movies', IsFolder: true, Path: 'Z:\\MetadataEditor'
    }));
    await database.insert('BaseItems', item(ids.movie, 'Movies.Movie', {
      Name: 'Visible Movie', ParentId: ids.folder, TopParentId: ids.folder, Path: 'Z:\\MetadataEditor\\visible.mkv',
      MediaType: 'Video', IsVirtualItem: false
    }));
    await database.insert('BaseItems', item(ids.hidden, 'Movies.Movie', {
      Name: 'Hidden Movie', ParentId: ids.folder, TopParentId: ids.folder, Path: 'Z:\\MetadataEditor\\hidden.mkv',
      MediaType: 'Video', IsVirtualItem: false, Tags: 'secret'
    }));
    await database.insert('BaseItems', item(ids.unknown, 'Plugin.Entities.CustomMedia', {
      Name: 'Unknown Plugin Item', ParentId: ids.folder, TopParentId: ids.folder,
      Path: 'Z:\\MetadataEditor\\unknown.bin', IsVirtualItem: false
    }));
    await database.insert('BaseItems', item(ids.virtual, 'Movies.Movie', {
      Name: 'Virtual Movie', ParentId: ids.folder, TopParentId: ids.folder, Path: null,
      MediaType: 'Video', IsVirtualItem: true
    }));

    const administrator = await runtime.users.createUser({ Name: 'MetadataAdmin', Password: 'admin-password' });
    const administratorRecord = await runtime.users.getUser(administrator.Id);
    await runtime.users.updatePolicy(administrator.Id, {
      ...administratorRecord.Policy, IsAdministrator: true, EnableAllFolders: true, BlockedTags: ['secret']
    });
    const adminUser = await runtime.users.getUser(administrator.Id);
    const adminLogin = await runtime.authentication.login({ Username: 'MetadataAdmin', Pw: 'admin-password' }, {
      Client: 'MetadataEditorTest', Device: 'Test Device', DeviceId: 'metadata-editor-admin', Version: '1'
    }, { remoteEndPoint: '127.0.0.1' });

    const reader = await runtime.users.createUser({ Name: 'MetadataReader', Password: 'reader-password' });
    const readerLogin = await runtime.authentication.login({ Username: 'MetadataReader', Pw: 'reader-password' }, {
      Client: 'MetadataEditorTest', Device: 'Test Device', DeviceId: 'metadata-editor-reader', Version: '1'
    }, { remoteEndPoint: '127.0.0.1' });
    const apiKey = await runtime.apiKeys.create('Metadata editor test');

    const direct = await runtime.metadataEditor.get(ids.movie, { user: adminUser });
    const data = loadLocalizationData();
    assert.deepEqual(direct.ParentalRatingOptions, data.parentalRatings('US'));
    assert.deepEqual(direct.Countries, data.countries);
    assert.deepEqual(direct.Cultures, data.cultures('en-US'));
    assert.deepEqual(direct.ExternalIdInfos, [
      { Name: 'IMDb', Key: 'Imdb', Type: null },
      { Name: 'TheMovieDb', Key: 'Tmdb', Type: 'Movie' },
      { Name: 'TheMovieDb', Key: 'TmdbCollection', Type: 'BoxSet' }
    ]);
    assert.equal(direct.ContentType, 'tvshows');
    assert.deepEqual(direct.ContentTypeOptions, [
      { Name: 'Inherit', Value: '' }, { Name: 'Movies', Value: 'movies' }, { Name: 'Shows', Value: 'tvshows' }
    ]);
    await assert.rejects(runtime.metadataEditor.get(ids.hidden, { user: adminUser }), error => error.status === 404);
    await assert.rejects(runtime.metadataEditor.get(ids.unknown, { user: adminUser }), error => error.status === 404);

    const baseItemsBefore = structuredClone(await database.rows('BaseItems'));
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    const request = (id, token) => fetch(`${origin}/Items/${id}/MetadataEditor`, {
      headers: token ? { Authorization: authorization(token) } : {}
    });

    const adminResponse = await request(ids.movie, adminLogin.AccessToken);
    assert.equal(adminResponse.status, 200);
    assert.deepEqual(parseLosslessJson(await adminResponse.text()), parseLosslessJson(stringifyNativeJson(direct)));
    const keyResponse = await request(ids.movie, apiKey.AccessToken);
    assert.equal(keyResponse.status, 200);
    assert.deepEqual(parseLosslessJson(await keyResponse.text()), parseLosslessJson(stringifyNativeJson(direct)));
    assert.equal((await request(ids.hidden, apiKey.AccessToken)).status, 200,
      'API keys have an empty native user id and therefore do not apply user visibility');
    const excludedResponse = await request(ids.virtual, adminLogin.AccessToken);
    assert.equal(excludedResponse.status, 200);
    const excludedBytes = await excludedResponse.text();
    assert.doesNotMatch(excludedBytes, /"ContentType":/u,
      'nullable ContentType is omitted by the native WhenWritingNull JSON policy');
    assert.match(excludedBytes, /"ContentTypeOptions":\[\]/u);
    const excludedBody = parseLosslessJson(excludedBytes);
    assert.equal(Object.hasOwn(excludedBody, 'ContentType'), false);
    assert.deepEqual(excludedBody.ContentTypeOptions, []);

    assert.equal((await request(ids.movie, readerLogin.AccessToken)).status, 403);
    assert.equal((await request(ids.hidden, adminLogin.AccessToken)).status, 404);
    assert.equal((await request(ids.missing, adminLogin.AccessToken)).status, 404);
    assert.equal((await request(ids.unknown, adminLogin.AccessToken)).status, 404);
    const malformed = await request('not-a-guid', adminLogin.AccessToken);
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.deepEqual(malformedBody.errors, { itemId: ["The value 'not-a-guid' is not valid."] });
    assert.equal((await request(ids.movie)).status, 401);
    assert.deepEqual(await database.rows('BaseItems'), baseItemsBefore, 'metadata editor reads must not mutate the library');
  } finally {
    await runtime.close();
    await dropPostgresSchema(connectionString, schema);
  }
});
