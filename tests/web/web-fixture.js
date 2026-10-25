import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { startProductionInstance } from '../../src/main.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { refreshLibraryTaskId } from '../../src/tasks/index.js';
import { decodeConfigurationXml } from '../../src/core/configuration-xml.js';
import { readXml, xmlNode } from '../../src/core/xml.js';
import { prepareMovieMedia } from './fixtures/movie-media.js';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

/** Serve the verified, unmodified client files on a different origin. No API proxy. */
export async function serveWebClient(root) {
  const resources = new Map(), errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://client.invalid').pathname);
      const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(root, filename);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        response.writeHead(403).end(); return;
      }
      let info;
      try { info = await stat(filename); } catch (error) { if (error.code === 'ENOENT') { response.writeHead(404).end(); return; } throw error; }
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      const bytes = await readFile(filename);
      resources.set(relative.replaceAll('\\', '/'), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] ?? 'application/octet-stream',
        'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    })().catch(error => { errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, resources, errors,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }) };
}

/** Import the current native database, then use the production entry and public APIs. */
export async function createWebServerFixture({ populated = false, resumePlayback = false, legacyAuthorization = true, preparation = {}, signal } = {}) {
  signal?.throwIfAborted();
  const supplied = await currentNativeSqliteInputs();
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-web-')));
  const instanceDirectory = path.join(directory, 'instance');
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  const errors = [];
  preparation.requests = [];
  preparation.runtimeErrors = [];
  preparation.cleanup = [];
  let database, application, closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const [name, action] of [
      ['production-instance', async () => {
        await application?.close();
        if (application) assert.ok(application.networkHost.listeners.every(entry => !entry.server.listening));
      }],
      ['postgres-schema', () => dropPostgresTestDatabase(database)],
      ['private-instance-and-media', async () => {
        assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('mediamanager-web-'));
        await rm(directory, { recursive: true, force: true });
      }]
    ]) {
      try { await action(); preparation.cleanup.push({ name, closed: true }); }
      catch (error) { failures.push(error); preparation.cleanup.push({ name, closed: false, error: error.message }); }
    }
    if (failures.length) throw new AggregateError(failures, 'Web fixture cleanup failed.');
  })();
  try {
    const serverId = supplied.initialization.serverId;
    assert.match(serverId, /^[a-f0-9]{32}$/iu);
    await mkdir(path.join(instanceDirectory, 'config'), { recursive: true });
    await mkdir(path.join(instanceDirectory, 'data/data'), { recursive: true });
    const resumePolicy = resumePlayback ? { MinResumePct: 1, MaxResumePct: 90, MinResumeDurationSeconds: 30 } : null;
    const resumeXml = Object.entries(resumePolicy ?? {}).map(([name, value]) => `<${name}>${value}</${name}>`).join('');
    await writeFile(path.join(instanceDirectory, 'config/system.xml'), `<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><EnableLegacyAuthorization>${legacyAuthorization}</EnableLegacyAuthorization><UICulture>en-US</UICulture><ServerName>Web acceptance</ServerName>${resumeXml}</ServerConfiguration>`);
    await writeFile(path.join(instanceDirectory, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses><AutoDiscovery>false</AutoDiscovery><EnablePublishedServerUriByRequest>true</EnablePublishedServerUriByRequest></NetworkConfiguration>');
    await writeFile(path.join(instanceDirectory, 'data/data/device.txt'), serverId);
    const mediaRoot = path.join(directory, 'media');
    const style = process.platform === 'win32' ? 'windows' : 'posix';
    let media, mountContract = supplied.receipt.mountContract;
    if (populated) {
      const movieDirectory = path.join(mediaRoot, 'Web feature (2026)');
      await mkdir(movieDirectory, { recursive: true });
      const filename = path.join(movieDirectory, 'Web feature (2026).mp4');
      const mediaPreparation = await prepareMovieMedia({ root: directory, filename, preparation, signal });
      await writeFile(path.join(movieDirectory, 'movie.nfo'), '<movie><title>Web feature</title><year>2026</year><plot>Controlled media for the unmodified Web client.</plot><runtime>2</runtime></movie>');
      await copyFile(new URL('../images/fixtures/processor/single.png', import.meta.url), path.join(movieDirectory, 'poster.png'));
      const files = {};
      for (const name of ['Web feature (2026).mp4', 'movie.nfo', 'poster.png']) {
        const bytes = await readFile(path.join(movieDirectory, name));
        files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      media = { name: 'Web feature', libraryName: 'Web Movies', files, preparation: mediaPreparation };
      mountContract = { mounts: [{ mountId: 'web-media', identityRoot: mediaRoot, accessRoot: '/web-media',
        pathStyle: style, caseSensitive: style !== 'windows', returnPolicy: 'required' }] };
      const filesystemRoot = path.parse(mediaRoot).root;
      await writeFile(path.join(directory, 'storage.json'), JSON.stringify({
        instances: [
          { id: 'web-media', type: 'local', config: { root: mediaRoot, createRoot: true, writable: true } },
          { id: 'web-ignore-ancestors', type: 'local', config: { root: filesystemRoot, writable: false } }
        ],
        mounts: [{ path: '/web-media', instanceId: 'web-media', root: '/', capabilities: {
          create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true
        } }, { path: '/web-ignore', instanceId: 'web-ignore-ancestors', root: '/', capabilities: {} }],
        prefixes: [{ identityRoot: mediaRoot, accessRoot: '/web-media', style, caseSensitive: style !== 'windows',
          returnAccess: 'Controlled Web media remains available for native return.', purpose: 'library' }],
        // Observe actual ancestor .ignore files, including their real absence.
        // This read-only namespace is used only by the ignore reader; it is not
        // a media identity prefix or an assumption of empty host ancestors.
        ignorePrefixes: [{ identityRoot: filesystemRoot, accessRoot: '/web-ignore', style,
          caseSensitive: style !== 'windows', returnAccess: 'Actual read-only ignore ancestry.' }]
      }));
    }
    database = await createPostgresTestDatabase(null, 'web_client');
    const privateDatabase = path.join(directory, 'input.db');
    await copyFile(supplied.filename, privateDatabase);
    const source = new SqliteDatabase(privateDatabase, { readOnly: true, requireMigrationHistory: true });
    let administratorToken;
    try {
      const administrators = new Set(source.rows('Permissions', { where: { Kind: 0, Value: true } }).map(row => row.UserId.toLowerCase()));
      administratorToken = source.rows('Devices').find(row => row.AccessToken && administrators.has(row.UserId?.toLowerCase()))?.AccessToken;
      assert.ok(administratorToken, 'The actual initialized native database must contain its authenticated administrator device.');
      secrets.add(administratorToken);
      await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: supplied.receipt.input.sha256 },
        portableMountContract: mountContract });
    } finally { source.close(); }
    await database.close();
    const environment = { ...process.env,
      MEDIAMANAGER_INSTANCE: instanceDirectory, MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES,
      MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      ...(populated ? { MEDIAMANAGER_STORAGE: path.join(directory, 'storage.json') } : {}) };
    const start = () => {
      signal?.throwIfAborted();
      return startProductionInstance({ environment, onError: error => {
        errors.push(error.message);
        preparation.runtimeErrors.push({ at: new Date().toISOString(), name: error.name, message: error.message,
          code: error.code, status: error.status, path: error.path, stack: error.stack });
      } });
    };
    application = await start();
    const origin = `http://127.0.0.1:${application.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const administratorRequest = async (pathname, { method = 'GET', body } = {}) => {
      const response = await fetch(`${origin}${pathname}`, {
        method, headers: { Authorization: `MediaBrowser Token="${administratorToken}"`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      preparation.requests.push({ pathname, method, status: response.status,
        ...(response.ok ? {} : { body: await response.clone().text() }) });
      return response;
    };
    if (media) {
      // The controlled NFO/image consumer has no external metadata dependency.
      assert.equal((await administratorRequest('/Plugins/tmdb/Enabled', { method: 'POST', body: { enabled: false } })).status, 200);
      assert.equal((await administratorRequest(`/Library/VirtualFolders?name=${encodeURIComponent(media.libraryName)}&collectionType=movies&refreshLibrary=false`, {
        method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: mediaRoot }], EnableRealtimeMonitor: false,
          EnableInternetProviders: false, PreferredMetadataLanguage: 'en-US' } }
      })).status, 204);
      const completed = once(application.tasks, 'completed', { signal: AbortSignal.timeout(90000) });
      assert.equal((await administratorRequest('/Library/Refresh', { method: 'POST' })).status, 204);
      const [{ Result }] = await completed;
      assert.equal(Result.Id, refreshLibraryTaskId);
      assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
      await application.metadata.drain();
      const discovered = await administratorRequest('/Items?IncludeItemTypes=Movie&Recursive=true&Fields=MediaSources,Overview,Path');
      assert.equal(discovered.status, 200);
      const movies = (await discovered.json()).Items;
      assert.equal(movies.length, 1);
      assert.equal(movies[0].Name, media.name);
      assert.ok(movies[0].ImageTags.Primary, 'The real scan must discover the controlled local image.');
      media.item = movies[0];
      media.scan = Result;
      const status = await administratorRequest('/Storage/Status');
      assert.equal(status.status, 200);
      media.storage = await status.json();
    }
    const username = `Web_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = randomUUID(); secrets.add(password);
    // Fixture preparation uses the real public API; the browser receives no token
    // or localStorage seed and must authenticate with the visible login form.
    const response = await fetch(`${origin}/Users/New`, { method: 'POST', headers: {
      Authorization: `MediaBrowser Token="${administratorToken}"`, 'Content-Type': 'application/json'
    }, body: JSON.stringify({ Name: username, Password: password }) });
    assert.equal(response.status, 200);
    const user = await response.json();
    assert.equal(user.Name, username);
    return { origin, get application() { return application; }, username, password, userId: user.Id, secrets, errors, close, media,
      administratorRequest,
      source: { sha256: supplied.receipt.input.sha256, serverId, mountContract, resumePolicy },
      async restart() {
        const previous = application.networkHost.listeners;
        const port = previous.find(entry => entry.scheme === 'http').port;
        await application.close();
        assert.ok(previous.every(entry => !entry.server.listening));
        const filename = path.join(instanceDirectory, 'config/network.xml'), before = await readFile(filename);
        // Change only the selected XML field. Other known values retain their
        // original text, so setters such as BaseUrl do not run an extra time.
        const document = readXml(decodeConfigurationXml(before));
        const field = document.children.findLast(node => node.name === 'InternalHttpPort' && !node.namespaces.xmlns);
        if (field) { field.content = [String(port)]; field.text = String(port); field.children = []; }
        else document.content.push({ name: 'InternalHttpPort', attributes: {}, content: [String(port)] });
        const after = Buffer.from(xmlNode(document), 'utf8');
        await writeFile(filename, after);
        (preparation.restarts ??= []).push({ port,
          networkBefore: { bytes: before.length, sha256: createHash('sha256').update(before).digest('hex') },
          networkAfter: { bytes: after.length, sha256: createHash('sha256').update(after).digest('hex') },
          closedListeners: previous.map(entry => ({ scheme: entry.scheme, address: entry.address,
            port: entry.port, listening: entry.server.listening })) });
        application = await start();
        assert.equal(`http://127.0.0.1:${application.networkHost.listeners.find(entry => entry.scheme === 'http').port}`, origin);
      },
      async savedUserData(itemId) {
        return application.store.run(database => database.rows('UserData', {
          where: { UserId: nativeGuid(user.Id), ItemId: nativeGuid(itemId) }
        }));
      },
      async savedPreference(key) {
        return application.store.run(database => database.rows('CustomItemDisplayPreferences', {
          where: { UserId: nativeGuid(user.Id), Client: 'emby', Key: key }
        }));
      } };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Web fixture startup and cleanup failed.'); }
    throw error;
  }
}
