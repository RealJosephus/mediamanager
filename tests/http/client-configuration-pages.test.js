import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

test('actual route plugins publish configuration pages with client permissions and activation lifetime', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-client-pages-')));
  let database, runtime;
  const errors = [];
  t.after(async () => {
    const failures = [];
    for (const action of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mediamanager-client-pages-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await action(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Configuration page cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'client_pages');
  runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'data'),
    configurationDirectoryPath: path.join(root, 'config'),
    serverId: randomUUID().replaceAll('-', ''),
    configuration: { IsStartupWizardCompleted: true }, onError: error => errors.push(error.message) });
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const adminToken = (await runtime.apiKeys.create('Configuration pages')).AccessToken;
  const user = await runtime.users.createUser({ Name: 'Page reader' });
  const other = await runtime.users.createUser({ Name: 'Other page reader' });
  const login = await runtime.authentication.login({ Username: user.Name, Pw: '' }, {
    Client: 'Jellyfin Web', Device: 'Browser', DeviceId: 'page-reader', Version: '13.0.0',
  });
  const auth = (token, client = 'Jellyfin Web') => ({ Authorization: `MediaBrowser Client="${client}", Token="${token}"` });
  const admin = auth(adminToken), reader = auth(login.AccessToken), emby = auth(login.AccessToken, 'Emby Web');
  const request = async (route, headers, method = 'GET') => {
    const response = await fetch(origin + route, { headers, method });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined };
  };
  assert.equal((await request('/web/ConfigurationPages')).status, 401);
  assert.equal((await request('/web/ConfigurationPages', reader)).status, 403);
  assert.deepEqual((await request('/web/ConfigurationPages', admin)).body, []);
  assert.deepEqual((await request('/emby/web/ConfigurationPages?EnableInUserMenu=true', emby)).body, []);
  const publicPage = { name: 'ReaderPage', displayName: 'Reader settings', enableInUserMenu: true, isMainConfigPage: true,
    menuIcon: 'settings', content: '<!doctype html><title>Reader 設定</title><main>Actual plugin page</main>' };
  const adminPage = { name: 'AdminPage', enableInMainMenu: true, menuSection: 'server',
    content: 'export const page = "actual configuration script";', contentType: 'application/javascript' };
  const packageDirectory = async (id, pages, fail = false) => {
    const directory = path.join(root, id);
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@test/' + id, version: '0.1.0',
      type: 'module', mediamanager: { id, name: 'Controlled client pages', entry: 'index.js' } }));
    await writeFile(path.join(directory, 'index.js'), `export async function activate(context) {
      for (const [index, configurationPage] of ${JSON.stringify(pages)}.entries()) {
        await context.register('route', { method: 'GET', path: '/PagePlugin/${id}/' + index,
          handle: () => ({ active: true }), configurationPage });
      }
      ${fail ? 'throw new Error("Controlled page activation failure.");' : ''}
    }`);
    return directory;
  };
  await runtime.plugins.install(await packageDirectory('client-pages', [publicPage, adminPage]));
  const expected = page => ({ Name: page.name, EnableInMainMenu: page.enableInMainMenu ?? false,
    ...(page.menuSection && { MenuSection: page.menuSection }), ...(page.menuIcon && { MenuIcon: page.menuIcon }),
    DisplayName: page.displayName ?? page.name });
  const embyPage = page => ({ ...expected(page), EnableInUserMenu: page.enableInUserMenu ?? false,
    ConfigurationPageType: page.isMainConfigPage ? 'PluginConfiguration' : 'None' });
  assert.deepEqual((await request('/web/ConfigurationPages', admin)).body, [publicPage, adminPage].map(expected));
  assert.deepEqual((await request('/web/ConfigurationPages?EnableInMainMenu=true', admin)).body, [expected(adminPage)]);
  assert.equal((await request('/web/ConfigurationPages?EnableInMainMenu=invalid', admin)).status, 400);
  assert.deepEqual((await request('/web/ConfigurationPages?EnableInUserMenu=invalid', admin)).body,
    [publicPage, adminPage].map(expected), 'The native controller does not bind the Emby-only argument.');
  assert.equal((await request('/emby/web/ConfigurationPages', reader)).status, 403,
    'An explicit Jellyfin client retains elevation on an Emby path.');
  const userMenu = `/emby/web/ConfigurationPages?EnableInUserMenu=true&UserId=${user.Id}`;
  assert.deepEqual((await request(userMenu, emby)).body, [embyPage(publicPage)]);
  assert.deepEqual((await request('/emby/web/ConfigurationPages', emby)).body,
    [publicPage, adminPage].map(embyPage));
  assert.deepEqual((await request(userMenu.replace(user.Id, other.Id), emby)).body, [embyPage(publicPage)]);
  const invalidUser = await request(userMenu.replace(user.Id, 'invalid'), { ...emby, Accept: 'application/json' });
  assert.equal(invalidUser.status, 500); assert.equal(invalidUser.text, 'Unrecognized Guid format.');
  assert.equal(invalidUser.headers.get('content-type'), 'text/plain');
  const invalidFlag = await request('/emby/web/ConfigurationPages?EnableInUserMenu=invalid', { ...emby, Accept: 'application/json' });
  assert.equal(invalidFlag.status, 500); assert.equal(invalidFlag.text, "String 'invalid' was not recognized as a valid Boolean.");
  assert.equal(invalidFlag.headers.get('content-type'), 'text/plain');
  assert.deepEqual((await request(userMenu.replace(user.Id, other.Id), auth(adminToken, 'Emby Web'))).body,
    [embyPage(publicPage)]);
  for (const page of [publicPage, adminPage]) {
    const route = '/web/ConfigurationPage?name=' + page.name.toLowerCase();
    const response = await request(route);
    assert.equal(response.status, 200); assert.equal(response.text, page.content);
    assert.equal(response.headers.get('content-type'), (page.contentType ?? 'text/html') + '; charset=utf-8');
    const head = await request(route, undefined, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.text, '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(page.content));
  }
  assert.equal((await request('/web/ConfigurationPage')).status, 404);
  assert.equal((await request('/web/ConfigurationPage?name=missing')).status, 404);
  await runtime.plugins.setEnabled('client-pages', false);
  assert.deepEqual((await request('/web/ConfigurationPages', admin)).body, []);
  assert.equal((await request('/web/ConfigurationPage?name=ReaderPage')).status, 404);
  await runtime.plugins.setEnabled('client-pages', true);
  assert.equal((await request('/web/ConfigurationPage?name=ReaderPage')).text, publicPage.content);
  await assert.rejects(runtime.plugins.install(await packageDirectory('duplicate-pages', [{ ...publicPage, name: 'readerpage' }])),
    /conflicting plugin configuration page/);
  await assert.rejects(runtime.plugins.install(await packageDirectory('failed-pages', [{ ...publicPage, name: 'UncommittedPage' }], true)),
    /Controlled page activation failure/);
  assert.equal((await request('/web/ConfigurationPage?name=UncommittedPage')).status, 404);
  assert.deepEqual((await request('/web/ConfigurationPages', admin)).body, [publicPage, adminPage].map(expected));
  await runtime.plugins.uninstall('client-pages');
  assert.equal((await request('/web/ConfigurationPage?name=ReaderPage')).status, 404);
});
