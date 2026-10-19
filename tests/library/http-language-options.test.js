import { testFileSystem } from '../storage/plugin-files.js';
import { validationFileUrl, validationOutputRoot } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { loadLibraryOptions, parseLibraryOptions, createVirtualPathExpander } from '../../src/library/options.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const streamFixture = JSON.parse(readFileSync(validationFileUrl('./fixtures/reference-streams.json', import.meta.url), 'utf8'));
const localeFixture = JSON.parse(readFileSync(validationFileUrl('./fixtures/reference-locales.json', import.meta.url), 'utf8'));
const optionsFixture = JSON.parse(readFileSync(validationFileUrl('./fixtures/reference-library-options.json', import.meta.url), 'utf8'));
const playlistControlBytes = readFileSync(validationFileUrl('./fixtures/root-initialization/playlist-root-http.json', import.meta.url));
assert.equal(createHash('sha256').update(playlistControlBytes).digest('hex'), '3c5aa84c9a474354a5b09d5fc45c1e21af2a4ee68eb0a27bc246beb741cdf14f');
const playlistControl = JSON.parse(playlistControlBytes);
assert.equal(playlistControl.source.dllSha256, '31236d2a520e52ab2130742515a552980b0edbde4cfe8da124c0a0cd87c9046c');
const nativePlaylists = playlistControl.record.response.bodyJson.Items.find(item => item.Name === 'Playlists');
const nativeMedia = JSON.parse(readFileSync(validationFileUrl('./fixtures/reference-media.json', import.meta.url), 'utf8')).tables.BaseItems.find(row => row.Id.replaceAll('-', '').toLowerCase() === streamFixture.expectedSource.Id);
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));
const collection = (id, folder, name) => ({ ...empty('BaseItems'), Id: id, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), IsFolder: true, Path: folder, Data: '{"CollectionType":"movies","PhysicalFolderIds":[]}', MediaType: 'Unknown' });

async function temporaryOptionsDirectory() {
  const root = validationOutputRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'library-options-test-'));
}

async function startRuntime(database, programDataPath) {
  const runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'localization-test', programDataPath });
  runtime.sessions.automaticProgress = false;
  await runtime.users.createUser({ Name: 'Viewer', Password: 'test-password' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  let token;
  async function call(route, { language = 'en-US', body } = {}) {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `MediaBrowser Client="LocaleTest", Device="IsolatedTest", DeviceId="locale-test", Version="1"${token ? `, Token="${token}"` : ''}`, 'Accept-Language': language, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, language: response.headers.get('content-language'), body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  }
  const login = await call('/Users/AuthenticateByName', { body: { Username: 'Viewer', Pw: 'test-password' } });
  assert.equal(login.status, 200); token = login.body.AccessToken;
  return { runtime, call };
}

test('full HTTP media and NowPlaying use native request UI language without concurrent context leakage',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'http_language');
  const testRoot = await temporaryOptionsDirectory();
  t.after(async () => {
    assert.ok(path.resolve(testRoot).startsWith(path.join(validationOutputRoot(), 'library-options-test-')));
    await rm(testRoot, { recursive: true });
  });
  await database.insert('BaseItems', { ...nativeMedia, ParentId: null, TopParentId: null, RunTimeTicks: BigInt(nativeMedia.RunTimeTicks) });
  for (const row of streamFixture.rows) await database.insert('MediaStreamInfos', row);
  const { runtime, call } = await startRuntime(database, path.join(testRoot, 'data'));
  const expectedScope = new AsyncLocalStorage();
  const run = runtime.localization.run.bind(runtime.localization);
  runtime.localization.run = (context, callback) => expectedScope.run(context, () => run(context, callback));
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime.localization), 'context');
  const observations = [];
  Object.defineProperty(runtime.localization, 'context', { get() {
    const actual = descriptor.get.call(this);
    if (expectedScope.getStore()) observations.push({ expected: expectedScope.getStore(), actual });
    return actual;
  } });
  try {
    for (const fixture of localeFixture) {
      const route = `/Items/${streamFixture.expectedSource.Id}${fixture.request.query ?? ''}`;
      const response = await call(route, fixture.request);
      assert.equal(response.status, fixture.status);
      assert.equal(response.language, 'en-US');
      assert.deepEqual(response.body.MediaStreams, fixture.streams);
      const started = await call(`/Sessions/Playing${fixture.request.query ?? ''}`, { ...fixture.request, body: { ItemId: streamFixture.expectedSource.Id, PositionTicks: 0, PlayMethod: 'DirectPlay' } });
      assert.equal(started.status, 204);
      const sessions = await call('/Sessions?deviceId=locale-test');
      assert.deepEqual(sessions.body[0].NowPlayingItem.MediaStreams, fixture.nowPlayingStreams);
    }
    observations.length = 0;
    const concurrent = Array.from({ length: 24 }, (_, index) => localeFixture[index % localeFixture.length]);
    const responses = await Promise.all(concurrent.map(fixture => call(`/Items/${streamFixture.expectedSource.Id}${fixture.request.query ?? ''}`, fixture.request)));
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200);
      assert.equal(response.language, 'en-US');
      assert.deepEqual(response.body.MediaStreams, concurrent[index].streams);
    }
    // Request culture remains isolated for sorting and formatting even though
    // all server messages use the same English catalogue.
    assert.equal(observations.length, 24 * 26);
    for (const { expected, actual } of observations) assert.deepEqual(actual, expected);
    assert.equal(observations.filter(({ actual }) => actual.uiCulture === 'en-US').length, 8 * 26);
    assert.equal(observations.filter(({ actual }) => actual.culture === 'en-US' && actual.uiCulture === 'zh-CN').length, 8 * 26);
    assert.equal(runtime.localization.context.uiCulture, 'en-US');
  } finally { await runtime.close(); }
});

test('runtime reads actual native options.xml and denies disabled libraries over HTTP',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const testRoot = await temporaryOptionsDirectory();
  const programDataPath = path.join(testRoot, 'data');
  const database = await createPostgresTestDatabase(t, 'http_library_options');
  let runtime;
  try {
    const ids = [];
    const userRootPath = path.join(programDataPath, 'root', 'default');
    const userRootId = getNewItemId(userRootPath, 'MediaBrowser.Controller.Entities.UserRootFolder', { programDataPath });
    await database.insert('BaseItems', { ...empty('BaseItems'), Id: userRootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder',
      Name: 'default', CleanName: 'default', SortName: 'default', IsFolder: true, MediaType: 'Unknown', Path: userRootPath, Data: '{}' });
    for (const [index, expected] of optionsFixture.entries()) {
      const id = `99111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`;
      const folder = path.join(programDataPath, 'root', 'default', expected.enabled ? 'Enabled' : 'Disabled');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'options.xml'), `<LibraryOptions><Enabled>${expected.enabled}</Enabled><SeasonZeroDisplayName>001</SeasonZeroDisplayName></LibraryOptions>`);
      await database.insert('BaseItems', { ...collection(id, folder, expected.enabled ? 'Enabled' : 'Disabled'), ParentId: userRootId }); ids.push(id);
    }
    const started = await startRuntime(database, programDataPath); runtime = started.runtime;
    for (const [index, expected] of optionsFixture.entries()) assert.equal((await started.call(`/Items/${ids[index]}`)).status, expected.status);
    const list = await started.call('/Items');
    assert.deepEqual(list.body.Items.map(item => item.Name), ['Enabled', 'Playlists']);
    const playlists = list.body.Items.find(item => item.Name === 'Playlists');
    assert.deepEqual({ Id: playlists.Id, Type: playlists.Type, CollectionType: playlists.CollectionType }, {
      Id: nativePlaylists.Id, Type: nativePlaylists.Type, CollectionType: nativePlaylists.CollectionType,
    });
    assert.equal(runtime.library.options.libraryOptions.get(ids[1].replaceAll('-', '')).SeasonZeroDisplayName, '001');
  } finally {
    if (runtime) await runtime.close();
    assert.ok(path.resolve(testRoot).startsWith(path.join(validationOutputRoot(), 'library-options-test-')));
    await rm(testRoot, { recursive: true });
  }
});

test('native library options preserve text, defaults and virtual media paths', () => {
  const expandPath = createVirtualPathExpander({ programDataPath: 'D:\\state', metadataPath: 'D:\\metadata' });
  const options = parseLibraryOptions('<LibraryOptions><Enabled>0</Enabled><SeasonZeroDisplayName>001</SeasonZeroDisplayName><SubtitleDownloadLanguages><string>zh-Hans</string><string>001</string></SubtitleDownloadLanguages><PathInfos><MediaPathInfo><Path>%appdatapath%\\media</Path></MediaPathInfo></PathInfos><TypeOptions><TypeOptions><Type>Movie</Type><MetadataFetcherOrder><string>001</string></MetadataFetcherOrder><ImageOptions><ImageOption><Type>Backdrop</Type><MinWidth>1280</MinWidth></ImageOption></ImageOptions></TypeOptions></TypeOptions></LibraryOptions>', { expandPath });
  assert.equal(options.Enabled, false);
  assert.equal(options.SeasonZeroDisplayName, '001');
  assert.equal(options.EnablePhotos, true);
  assert.equal(options.SaveLyricsWithMedia, false);
  assert.deepEqual(options.SubtitleDownloadLanguages, ['zh-Hans', '001']);
  assert.equal(options.PathInfos[0].Path, path.join('D:\\state', 'data') + '\\media');
  assert.deepEqual(options.TypeOptions[0].MetadataFetcherOrder, ['001']);
  assert.deepEqual(options.TypeOptions[0].ImageOptions, [{ Type: 'Backdrop', Limit: 1, MinWidth: 1280 }]);
  assert.throws(() => parseLibraryOptions('<LibraryOptions><Enabled>False</Enabled></LibraryOptions>'));
  assert.throws(() => parseLibraryOptions('<LibraryOptions><AutomaticRefreshIntervalDays>2147483648</AutomaticRefreshIntervalDays></LibraryOptions>'));
});

test('library options loader uses native invalid-file defaults and rejects junction escapes',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const testRoot = await temporaryOptionsDirectory();
  const database = await createPostgresTestDatabase(t, 'library_options_loader');
  const state = path.join(testRoot, 'data'), libraryPath = path.join(state, 'root', 'default', 'Movies');
  const id = '99111111-1111-1111-1111-111111111111';
  try {
    await mkdir(libraryPath, { recursive: true });
    await database.insert('BaseItems', collection(id, libraryPath, 'Movies'));
    assert.equal((await loadLibraryOptions(database, {fileSystem: testFileSystem,  programDataPath: state })).get(id.replaceAll('-', '')).Enabled, true);
    await writeFile(path.join(libraryPath, 'options.xml'), '<LibraryOptions><Enabled>false');
    const errors = [];
    assert.equal((await loadLibraryOptions(database, {fileSystem: testFileSystem,  programDataPath: state, onError: error => errors.push(error) })).get(id.replaceAll('-', '')).Enabled, true);
    assert.equal(errors.length, 1);
    const outside = path.join(testRoot, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'options.xml'), '<LibraryOptions><Enabled>false</Enabled></LibraryOptions>');
    const link = path.join(state, 'root', 'escaped'); await symlink(outside, link, 'junction');
    await database.update('BaseItems', { Id: id }, { Path: link });
    await assert.rejects(loadLibraryOptions(database, {fileSystem: testFileSystem,  programDataPath: state }), error => error.code === 'UNSAFE_LIBRARY_OPTIONS_PATH');
    await database.update('BaseItems', { Id: id }, { Path: outside });
    await assert.rejects(loadLibraryOptions(database, {fileSystem: testFileSystem,  programDataPath: state }), error => error.code === 'UNSAFE_LIBRARY_OPTIONS_PATH');
  } finally {
    assert.ok(path.resolve(testRoot).startsWith(path.join(validationOutputRoot(), 'library-options-test-')));
    await rm(testRoot, { recursive: true });
  }
});
