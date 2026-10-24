import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { homeSectionClient, homeSectionItemId } from '../../src/users/emby-home-sections.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const bytes = await readFile(new URL('./fixtures/emby-home-sections/reference.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '6de9fcc92fdadafe372f1991b70e9aa20b82aff5226850dbdd2b42cb66136343');
const reference = JSON.parse(bytes);
const modelBytes = await readFile(new URL('./fixtures/emby-home-sections/model.json', import.meta.url));
assert.equal(createHash('sha256').update(modelBytes).digest('hex'), '2a9e5fe78953f410e6287eef72df74faf3fceeb78c8495c7be6cc0a9c73fd1ba');
const model = JSON.parse(modelBytes), native = label => [...reference.records, ...model.records].find(record => record.label === label);
const sectionFields = ['Name', 'CustomName', 'Subtitle', 'Id', 'SectionType', 'CollectionType', 'DisplayMode', 'Monitor',
  'ItemTypes', 'ExcludedFolders', 'CardSizeOffset', 'ScrollDirection', 'ViewType', 'ImageType', 'SortBy', 'SortOrder',
  'IncludeNextUpInResume', 'Query', 'PremiumFeature', 'PremiumMessage', 'RefreshInterval', 'ParentId', 'TextInfo'];
const layout = sections => sections.map(section => ({ ...Object.fromEntries(sectionFields.filter(key => Object.hasOwn(section, key)).map(key => [key, section[key]])),
  ...(section.ParentItem && { ParentItem: Object.fromEntries(['Id', 'Name', 'Type', 'CollectionType'].map(key => [key, section.ParentItem[key]])) }) }));

test('Emby home section layouts preserve scoped edits, generated identities, display modes, copies and restart', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  for (const source of [reference.source, model.source]) for (const key of ['referenceUnchanged', 'runtimeUnchanged', 'processesStopped', 'instanceRemoved']) assert.equal(source[key], true);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-home-sections-')));
  const options = { serverId: randomUUID().replaceAll('-', ''), configuration: { BaseUrl: '/media', IsStartupWizardCompleted: true },
    programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config') };
  let database, runtime;
  const open = async () => { runtime = await createRuntime({ database, ...options }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve)); };
  t.after(async () => {
    const failures = [];
    for (const operation of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mediamanager-home-sections-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await operation(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Home section cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'emby_home'); await open();
  const password = randomUUID(), source = await runtime.users.createUser({ Name: 'Controlled reader', Password: password });
  const target = await runtime.users.createUser({ Name: 'Controlled target', Password: password });
  const login = async user => (await runtime.authentication.login({ Username: user.Name, Pw: password }, {
    Client: 'Emby Web', Device: 'Controlled browser', DeviceId: user.Id, Version: '1.0',
  })).AccessToken;
  const sourceToken = await login(source), targetToken = await login(target), adminToken = (await runtime.apiKeys.create('Home layouts')).AccessToken;
  const userRoot = await runtime.libraryScanHost.getUserRootFolder();
  const ids = { root: userRoot.Id,
    ...Object.fromEntries(['collection', 'folder'].map(key => [key, nativeGuid(randomUUID())])) };
  await database.insertBatch('BaseItems', [
    postgresTestRow('BaseItems', { Id: ids.root, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'Media Folders', Path: userRoot.Path, IsFolder: true, Data: '{}', PresentationUniqueKey: ids.root }),
    postgresTestRow('BaseItems', { Id: ids.collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Controlled music', IsFolder: true,
      ParentId: ids.root, Path: path.join(options.programDataPath, 'root', 'default', 'Controlled music'), PresentationUniqueKey: ids.collection,
      Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.folder] }) }),
    postgresTestRow('BaseItems', { Id: ids.folder, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Audio files', IsFolder: true,
      TopParentId: ids.folder, Data: '{}', PresentationUniqueKey: ids.folder }),
  ]);
  const policy = (await runtime.users.getUser(source.Id)).Policy;
  await runtime.users.updatePolicy(source.Id, { ...policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  const map = new Map([[reference.source.identities.reader, source.Id], [reference.source.identities.other, target.Id],
    [reference.source.identities.homeLibraryId, wireGuid(ids.collection)], [model.source.identities.reader, source.Id]]);
  const route = value => value.replaceAll(reference.source.identities.reader, source.Id)
    .replaceAll(reference.source.identities.other, target.Id).replaceAll(model.source.identities.reader, source.Id);
  const translate = value => {
    if (typeof value === 'string') return map.get(value) ?? (value.startsWith('latestmedia_')
      ? 'latestmedia_' + (map.get(value.slice(12)) ?? value.slice(12)) : value);
    if (Array.isArray(value)) return value.map(translate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]));
    return value;
  };
  const request = async (route, { method = 'GET', body, token = sourceToken } = {}) => {
    const url = new URL(`http://127.0.0.1:${runtime.server.address().port}/media/emby${route}`);
    if (body !== undefined) url.searchParams.set('reqformat', 'json');
    const response = await fetch(url, { method, headers: { Authorization: `Emby Client="Emby Web", Token="${token ?? ''}"`,
      Accept: 'application/json', 'Content-Type': 'text/plain' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(), type = response.headers.get('content-type');
    return { status: response.status, text, type, body: text && type?.includes('json') ? JSON.parse(text) : undefined };
  };
  const compare = (result, label) => {
    const expected = native(label); assert.equal(result.status, expected.status, label);
    assert.equal(result.type?.split(';')[0], expected.contentType?.split(';')[0], label);
    if (Array.isArray(expected.bodyJson)) assert.deepEqual(layout(result.body), layout(translate(expected.bodyJson)), label);
    else assert.equal(result.text, expected.bodyText, label);
  };
  const get = async (label, token = sourceToken) => {
    const record = native(label), result = await request(route(record.route), { token });
    compare(result, label); return result;
  };
  const mutate = async (label, token = sourceToken) => {
    const record = native(label), result = await request(route(record.route), { method: record.method, body: translate(record.requestBody), token });
    compare(result, label); return result;
  };
  const bindGenerated = async (label, customName) => {
    const result = await request(`/Users/${source.Id}/HomeSections?IsEditMode=true`);
    assert.equal(result.status, 200);
    const actual = result.body.find(section => section.CustomName === customName), expected = native(label).bodyJson.find(section => section.CustomName === customName);
    assert.match(actual.Id, /^[a-f0-9]{32}$/u);
    assert.equal(result.body.filter(section => section.Id === actual.Id).length, 1);
    assert.ok(![...map.values()].includes(actual.Id)); map.set(expected.Id, actual.Id);
    compare(result, label);
  };
  for (const label of ['home-default-edit', 'home-default-expanded', 'home-default-desktop', 'home-default-tv', 'home-invalid-edit', 'home-unknown-mode', 'home-cross-read']) await get(label);
  await get('home-anonymous-read', null);
  await mutate('home-anonymous-save', null);
  await mutate('home-save-custom-default');
  for (const label of ['home-after-custom-default', 'home-custom-default-mobile', 'home-custom-default-desktop', 'home-custom-default-tv']) await get(label);
  await mutate('home-update-unknown-id');
  await mutate('home-add-audio-query');
  await bindGenerated('home-after-audio-query', 'Controlled audio query');
  await mutate('home-update-audio-favorites');
  await get('home-after-query-filter');
  await mutate('home-update-audio-exclude-library');
  const excluded = (await request(`/Users/${source.Id}/HomeSections?IsEditMode=true`)).body.find(section => section.CustomName === 'Controlled audio query');
  assert.deepEqual(excluded.ExcludedFolders, [wireGuid(ids.collection)]);
  await mutate('home-restore-audio-query');
  await mutate('home-add-generated-id');
  await bindGenerated('home-after-generated-id', 'Generated section');
  await mutate('home-cross-save');
  await get('home-source-after-cross-save');
  await get('home-target-after-cross-save', targetToken);
  for (const label of ['home-move-sections', 'home-move-unknown', 'home-move-negative', 'home-delete-unknown', 'home-delete-empty', 'home-delete-null']) {
    await mutate(label);
    if (label === 'home-move-sections') await get('home-after-move');
    if (label === 'home-move-unknown') await get('home-after-unknown-move');
    if (label === 'home-move-negative') await get('home-after-negative-move');
  }
  const beforeCopy = await get('home-before-copy');
  const original = await database.rows('CustomItemDisplayPreferences', { where: { UserId: nativeGuid(source.Id), ItemId: homeSectionItemId, Client: homeSectionClient } });
  assert.equal(original.length, 1);
  assert.equal(JSON.parse(original[0].Value).length, beforeCopy.body.length);
  await mutate('home-copy-configuration', adminToken);
  await get('home-target-after-copy', targetToken);
  const copied = await database.rows('CustomItemDisplayPreferences', { where: { UserId: nativeGuid(target.Id), ItemId: homeSectionItemId, Client: homeSectionClient } });
  assert.equal(copied.length, 1); assert.equal(copied[0].Value, original[0].Value);
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [] });
  await get('home-without-library-access');
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  const schema = database.schemaName;
  await runtime.close(); runtime = null;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
  await get('home-after-restart');
  await mutate('home-delete-all');
  await get('home-after-delete-all');
  await get('home-expanded-after-delete-all');
  assert.equal((await database.rows('CustomItemDisplayPreferences', { where: { UserId: nativeGuid(target.Id), ItemId: homeSectionItemId, Client: homeSectionClient } }))[0].Value, copied[0].Value);
  await get('model-default');
  await mutate('model-create');
  await bindGenerated('model-after-create', 'Controlled model');
  for (const label of ['model-string-sort-order', 'model-number-sort-order', 'model-string-boolean']) {
    await mutate(label); await get(label + '-readback');
  }
  await mutate('model-reset-valid');
  await get('model-before-restart');
  await runtime.close(); runtime = null;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
  await get('model-after-restart');
});
