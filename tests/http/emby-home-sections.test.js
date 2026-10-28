import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { homeSectionClient, homeSectionItemId } from '../../src/users/emby-home-sections.js';
import { clearFolderChildIds } from '../../src/library/folder-cache.js';
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
const bound = (value, identities) => identities.get(value) ?? value;
const sectionId = (value, identities) => typeof value === 'string' && value.startsWith('latestmedia_')
  ? 'latestmedia_' + bound(value.slice(12), identities.items) : bound(value, identities.sections);
function rebindSection(section, identities) {
  const result = structuredClone(section);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (Object.hasOwn(result, 'Id')) result.Id = sectionId(result.Id, identities);
  if (Object.hasOwn(result, 'UserId')) result.UserId = bound(result.UserId, identities.users);
  if (Object.hasOwn(result, 'ParentId')) result.ParentId = bound(result.ParentId, identities.items);
  if (Array.isArray(result.ExcludedFolders)) result.ExcludedFolders = result.ExcludedFolders.map(value => bound(value, identities.items));
  if (result.ParentItem && Object.hasOwn(result.ParentItem, 'Id')) result.ParentItem.Id = bound(result.ParentItem.Id, identities.items);
  // This fixture binds no Studio/Tag/Genre identities in Query. Filter values,
  // TextInfo, names and unknown content remain literal, even when GUID-shaped.
  return result;
}
const rebindRoute = (route, identities) => route.replace(/^\/Users\/([^/?]+)/u, (_, userId) => '/Users/' + bound(userId, identities.users));
function rebindRequest(record, identities) {
  const route = record.route.split('?')[0], body = structuredClone(record.requestBody);
  if (/\/HomeSections$/u.test(route)) return rebindSection(body, identities);
  if (body && /\/HomeSections\/(?:Move|Delete)$/u.test(route) && Array.isArray(body.Ids)) {
    body.Ids = body.Ids.map(value => sectionId(value, identities));
  }
  if (body && /\/CopyData$/u.test(route) && Array.isArray(body.ToUserIds)) body.ToUserIds = body.ToUserIds.map(value => bound(value, identities.users));
  return body;
}
function compareLayoutResponse(result, expected, identities, label) {
  assert.equal(result.status, expected.status, label);
  assert.equal(result.type?.trim(), expected.contentType?.trim(), label);
  if (Array.isArray(expected.bodyJson)) assert.deepEqual(layout(result.body), layout(expected.bodyJson.map(section => rebindSection(section, identities))), label);
  else assert.equal(result.text, expected.bodyText, label);
}

test('Emby home layout identity bindings retain opaque text, request roles and Content-Type parameters', () => {
  const reader = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', currentReader = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const generated = 'dddddddddddddddddddddddddddddddd', currentGenerated = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const library = 'cccccccccccccccccccccccccccccccc';
  const identities = { users: new Map([[reader, currentReader]]), items: new Map([['3', library]]), sections: new Map([[generated, currentGenerated]]) };
  const section = { Id: generated, UserId: reader, ParentId: '3', ExcludedFolders: ['3', reader],
    ParentItem: { Id: '3', Name: '3', Type: 'CollectionFolder', CollectionType: 'music', Unknown: { Id: reader } },
    Name: reader, CustomName: '3', Subtitle: 'latestmedia_3', Monitor: [generated],
    TextInfo: { Id: generated, Text: '3', Name: reader, Unknown: { ParentId: '3' } },
    Query: { StudioIds: [reader], CollectionTypes: ['3'], Unknown: { Id: generated, UserId: reader } },
    Unknown: { Id: generated, UserId: reader, ParentId: '3' } };
  const original = structuredClone(section), actual = rebindSection(section, identities);
  assert.deepEqual({ Id: actual.Id, UserId: actual.UserId, ParentId: actual.ParentId, ExcludedFolders: actual.ExcludedFolders, ParentItemId: actual.ParentItem.Id },
    { Id: currentGenerated, UserId: currentReader, ParentId: library, ExcludedFolders: [library, reader], ParentItemId: library });
  for (const key of ['Name', 'CustomName', 'Subtitle', 'Monitor', 'TextInfo', 'Query', 'Unknown']) assert.deepEqual(actual[key], section[key]);
  assert.deepEqual(actual.ParentItem.Unknown, section.ParentItem.Unknown);
  assert.equal(rebindSection({ Id: 'latestmedia_3' }, identities).Id, 'latestmedia_' + library);
  assert.deepEqual(section, original);
  const expected = { status: 200, contentType: 'application/json; charset=utf-8; profile="urn:Emby:Profile"', bodyJson: [section] };
  const response = { status: 200, type: expected.contentType, body: [actual] };
  compareLayoutResponse(response, expected, identities);
  for (const change of [value => { value.CustomName = library; }, value => { value.Name = currentReader; },
    value => { value.TextInfo.Text = library; }, value => { value.TextInfo.Id = currentGenerated; },
    value => { value.Query.CollectionTypes = [library]; }, value => { value.Query.Unknown.Id = currentGenerated; }]) {
    const changed = structuredClone(response); change(changed.body[0]);
    assert.throws(() => compareLayoutResponse(changed, expected, identities), assert.AssertionError);
  }
  for (const type of ['application/json', 'application/json; charset=ascii; profile="urn:Emby:Profile"',
    'application/json; charset=utf-8; profile="urn:emby:profile"']) {
    assert.throws(() => compareLayoutResponse({ ...response, type }, expected, identities), assert.AssertionError);
  }
  const record = { route: '/Users/' + reader + '/HomeSections', requestBody: section };
  assert.deepEqual(rebindRequest(record, identities), actual);
  assert.equal(rebindRoute(record.route + '?CustomName=' + reader, identities), '/Users/' + currentReader + '/HomeSections?CustomName=' + reader);
  assert.deepEqual(rebindRequest({ route: record.route + '/Move', requestBody: { Ids: [generated], NewIndex: 3, CustomName: reader } }, identities),
    { Ids: [currentGenerated], NewIndex: 3, CustomName: reader });
  assert.deepEqual(rebindRequest({ route: '/Users/' + reader + '/CopyData', requestBody: { ToUserIds: [reader], CopyOptions: ['3'], Unknown: generated } }, identities),
    { ToUserIds: [currentReader], CopyOptions: ['3'], Unknown: generated });
  assert.deepEqual(record.requestBody, original);
});

test('Emby home section layouts preserve scoped edits, generated identities, display modes, copies and restart', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  for (const source of [reference.source, model.source]) for (const key of ['referenceUnchanged', 'runtimeUnchanged', 'processesStopped', 'instanceRemoved']) assert.equal(source[key], true);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-home-sections-')));
  const options = { serverId: randomUUID().replaceAll('-', ''), networkConfiguration: { BaseUrl: '/media' }, configuration: { IsStartupWizardCompleted: true },
    programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config') };
  let database, runtime;
  const open = async () => { runtime = await createTestRuntime({ database, ...options }); };
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
  clearFolderChildIds(userRoot);
  runtime.libraryScanHost.invalidateChildren(userRoot);
  const policy = (await runtime.users.getUser(source.Id)).Policy;
  await runtime.users.updatePolicy(source.Id, { ...policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  const identities = { users: new Map([[reference.source.identities.reader, source.Id], [reference.source.identities.other, target.Id],
    [model.source.identities.reader, source.Id]]), items: new Map([[reference.source.identities.homeLibraryId, wireGuid(ids.collection)]]), sections: new Map() };
  const route = value => rebindRoute(value, identities);
  const persistedLayout = async (userId, label) => {
    const rows = await database.rows('CustomItemDisplayPreferences', { where: {
      UserId: nativeGuid(userId), ItemId: homeSectionItemId, Client: homeSectionClient, Key: 'layout',
    } });
    assert.equal(rows.length, 1, label);
    const value = JSON.parse(rows[0].Value);
    assert.ok(Array.isArray(value), label);
    for (const section of value) assert.equal(Object.hasOwn(section, 'UserId'), false, label + ': contextual UserId must not persist on root sections.');
    return rows[0];
  };
  const request = async (route, { method = 'GET', body, token = sourceToken } = {}) => {
    const url = new URL(`http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}/media/emby${route}`);
    if (body !== undefined) url.searchParams.set('reqformat', 'json');
    const response = await fetch(url, { method, headers: { Authorization: `Emby Client="Emby Web", Token="${token ?? ''}"`,
      Accept: 'application/json', 'Content-Type': 'text/plain' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(), type = response.headers.get('content-type');
    return { status: response.status, text, type, body: text && type?.includes('json') ? JSON.parse(text) : undefined };
  };
  const compare = (result, label) => compareLayoutResponse(result, native(label), identities, label);
  const get = async (label, token = sourceToken) => {
    const record = native(label), result = await request(route(record.route), { token });
    compare(result, label); return result;
  };
  const mutate = async (label, token = sourceToken) => {
    const record = native(label), result = await request(route(record.route), { method: record.method, body: rebindRequest(record, identities), token });
    compare(result, label); return result;
  };
  const bindGenerated = async (label, customName) => {
    const result = await request(`/Users/${source.Id}/HomeSections?IsEditMode=true`);
    assert.equal(result.status, 200);
    const actual = result.body.find(section => section.CustomName === customName), expected = native(label).bodyJson.find(section => section.CustomName === customName);
    assert.match(actual.Id, /^[a-f0-9]{32}$/u);
    assert.equal(result.body.filter(section => section.Id === actual.Id).length, 1);
    assert.ok(!Object.values(identities).some(values => [...values.values()].includes(actual.Id)));
    identities.sections.set(expected.Id, actual.Id);
    compare(result, label);
  };
  for (const label of ['home-default-edit', 'home-default-expanded', 'home-default-desktop', 'home-default-tv', 'home-invalid-edit', 'home-unknown-mode', 'home-cross-read']) await get(label);
  await get('home-anonymous-read', null);
  await mutate('home-anonymous-save', null);
  await mutate('home-save-custom-default');
  await persistedLayout(source.Id, 'saved default section');
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
  const original = await persistedLayout(source.Id, 'edited source before copy');
  assert.equal(JSON.parse(original.Value).length, beforeCopy.body.length);
  await mutate('home-copy-configuration', adminToken);
  await get('home-target-after-copy', targetToken);
  const copied = await persistedLayout(target.Id, 'copied target');
  assert.equal(copied.Value, original.Value);
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [] });
  await get('home-without-library-access');
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  const schema = database.schemaName;
  await runtime.close(); runtime = null;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
  await persistedLayout(source.Id, 'source after cold restart');
  assert.equal((await persistedLayout(target.Id, 'copied target after cold restart')).Value, copied.Value);
  await get('home-after-restart');
  await mutate('home-delete-all');
  await get('home-after-delete-all');
  await get('home-expanded-after-delete-all');
  assert.equal((await persistedLayout(target.Id, 'target after source deletion')).Value, copied.Value);
  await get('model-default');
  await mutate('model-create');
  await persistedLayout(source.Id, 'saved model section');
  await bindGenerated('model-after-create', 'Controlled model');
  for (const label of ['model-string-sort-order', 'model-number-sort-order', 'model-string-boolean']) {
    await mutate(label); await get(label + '-readback');
  }
  await mutate('model-reset-valid');
  await get('model-before-restart');
  await persistedLayout(source.Id, 'model before cold restart');
  await runtime.close(); runtime = null;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
  await persistedLayout(source.Id, 'model after cold restart');
  await get('model-after-restart');
});
