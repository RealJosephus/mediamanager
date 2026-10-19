import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { startProductionInstance } from '../../src/main.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';

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

/** Import the actual current empty native database, then start the production entry. */
export async function createWebServerFixture() {
  const supplied = await currentNativeSqliteInputs();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-web-'));
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  const errors = [];
  let database, application, closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    try { await application?.close(); } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Web fixture cleanup failed.');
  })();
  try {
    const serverId = supplied.initialization.serverId;
    assert.match(serverId, /^[a-f0-9]{32}$/iu);
    await mkdir(path.join(directory, 'config'), { recursive: true });
    await mkdir(path.join(directory, 'data/data'), { recursive: true });
    await writeFile(path.join(directory, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><EnableLegacyAuthorization>true</EnableLegacyAuthorization><UICulture>en-US</UICulture><ServerName>Web acceptance</ServerName></ServerConfiguration>');
    await writeFile(path.join(directory, 'config/network.xml'), '<NetworkConfiguration><AutoDiscovery>false</AutoDiscovery></NetworkConfiguration>');
    await writeFile(path.join(directory, 'data/data/device.txt'), serverId);
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
        portableMountContract: supplied.receipt.mountContract });
    } finally { source.close(); }
    await database.close();
    application = await startProductionInstance({ environment: { ...process.env,
      MEDIAMANAGER_INSTANCE: directory, MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES,
      MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName, MEDIAMANAGER_PORT: '0' },
    onError: error => errors.push(error.message) });
    const origin = `http://127.0.0.1:${application.server.address().port}`;
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
    return { origin, application, username, password, userId: user.Id, secrets, errors, close,
      source: { sha256: supplied.receipt.input.sha256, serverId },
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
