import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeModel, quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';

const mediaId = '33333333-3333-3333-3333-333333333333';
const token = 'isolated-storage-api-secret';
const clientToken = 'isolated-client-api-key';
const portableMountContract = {
  mounts: [{ mountId: 'isolated-media', identityRoot: 'Z:\\Isolated', accessRoot: '/media', pathStyle: 'windows',
    caseSensitive: false, returnPolicy: 'required' }]
};
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storage-bootstrap-'));
  const calls = [];
  let slow = false;
  // This is an HTTP protocol fixture, not an actual AList service.
  const server = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    calls.push({ url: request.url, headers: request.headers, body: Buffer.concat(parts).toString() });
    if (request.url === '/api/fs/get') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ code: 200, data: { name: 'media.wav', is_dir: false, size: 10, raw_url: `http://127.0.0.1:${server.address().port}/raw` } }));
      return;
    }
    response.setHeader('Content-Type', 'audio/wav'); response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', '10');
    if (slow) { response.write('0'); return; }
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '');
    if (range) {
      const bytes = Buffer.from('0123456789').subarray(Number(range[1]), Number(range[2]) + 1);
      response.writeHead(206, { 'Content-Range': `bytes ${range[1]}-${range[2]}/10`, 'Content-Length': bytes.length });
      response.end(bytes); return;
    }
    response.end('0123456789');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const configuration = { instances: [{ id: 'source', type: 'alist', config: { baseUrl: `http://127.0.0.1:${server.address().port}`, credentialRef: 'ISOLATED_ALIST_TOKEN', password: 'isolated-directory-password' } }],
    mounts: [{ path: '/media', instanceId: 'source', root: '/library', capabilities: {} }],
    prefixes: [{ identityRoot: 'Z:\\Isolated', accessRoot: '/media', style: 'windows', caseSensitive: false, returnAccess: 'Protocol fixture only; native return access has not been verified.' }],
    bindings: [{ itemId: mediaId, accessPath: '/media/media.wav' }] };
  const filename = path.join(directory, 'storage.json');
  await writeFile(filename, JSON.stringify(configuration));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  return { directory, filename, configuration, calls, environment: { ISOLATED_ALIST_TOKEN: token }, slow: () => { slow = true; } };
}

async function setupWebDav(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storage-bootstrap-webdav-'));
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(parts) });
    if (request.method === 'PROPFIND') {
      const href = String(request.url).replaceAll('&', '&amp;');
      response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      response.end(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response>`
        + `<d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>4</d:getcontentlength>`
        + `<d:getetag>&quot;bootstrap-v1&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status>`
        + `</d:propstat></d:response></d:multistatus>`);
      return;
    }
    if (request.method === 'PUT') { response.writeHead(201); response.end(); return; }
    response.writeHead(405); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configuration = {
    instances: [
      { id: 'dav-a', type: 'webdav', config: { baseUrl: `${origin}/dav-a/`, credentialRef: 'DAV_A_AUTH', pageSize: 2,
        capabilities: { create: true, replace: true } } },
      { id: 'dav-b', type: 'webdav', config: { baseUrl: `${origin}/dav-b/`, credentialRef: 'DAV_B_AUTH' } },
    ],
    mounts: [
      { path: '/first', instanceId: 'dav-a', root: '/library', capabilities: { create: true } },
      { path: '/second', instanceId: 'dav-b', root: '/archive', capabilities: {} },
    ],
    prefixes: [], bindings: [],
  };
  const filename = path.join(directory, 'storage.json');
  await writeFile(filename, JSON.stringify(configuration));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  return { calls, configuration, environment: { DAV_A_AUTH: 'Basic alpha-secret', DAV_B_AUTH: 'Basic beta-secret' }, filename };
}

test('configured VFS performs authenticated AList API requests without passing secrets to object reads', async t => {
  const fixture = await setup(t);
  const storage = await createConfiguredStorage(fixture.filename, { environment: fixture.environment });
  t.after(() => storage.close());
  const accessPath = storage.identityMap.resolve({ itemId: mediaId.replaceAll('-', '').toUpperCase() });
  assert.equal(accessPath, '/media/media.wav');
  assert.equal(storage.identityMap.resolve({ identityPath: 'z:\\isolated\\media.wav', style: 'windows' }), accessPath);
  const handle = await storage.vfs.openRead(accessPath, { range: { start: 2, end: 5 } });
  const chunks = []; try { for await (const chunk of handle.stream) chunks.push(chunk); } finally { await handle.close(); }
  assert.equal(Buffer.concat(chunks).toString(), '2345');
  assert.equal(fixture.calls[0].headers.authorization, token);
  assert.equal(JSON.parse(fixture.calls[0].body).password, 'isolated-directory-password');
  assert.equal(fixture.calls[1].headers.authorization, undefined);
  assert.equal(fixture.calls[1].headers.cookie, undefined);
  assert.equal(JSON.stringify(storage.identityMap.exportState()).includes(token), false);
  await storage.close(); await storage.close();
  await assert.rejects(storage.vfs.stat(accessPath), { code: 'closed' });
});

test('configured storage fails closed when runtime paths drift from PostgreSQL portable state', async t => {
  const fixture = await setup(t);
  const storage = await createConfiguredStorage(fixture.filename, {
    environment: fixture.environment,
    portableMountContract,
  });
  assert.deepEqual(storage.portableMountContract, portableMountContract);
  await storage.close();

  fixture.configuration.prefixes[0].identityRoot = 'Y:\\Drifted';
  await writeFile(fixture.filename, JSON.stringify(fixture.configuration));
  await assert.rejects(createConfiguredStorage(fixture.filename, {
    environment: fixture.environment,
    portableMountContract,
  }), /differ from the persisted portable VFS mount contract/u);
  assert.equal(fixture.calls.length, 0);
});

test('storage keeps unavailable instances recoverable and rejects invalid configuration without exposing secrets', async t => {
  const fixture = await setup(t);
  const environment = {};
  const storage = await createConfiguredStorage(fixture.filename, { environment });
  t.after(() => storage.close());
  assert.equal(storage.status().find(instance => instance.id === 'source').available, false);
  await assert.rejects(storage.configure(fixture.configuration), error => /missing or invalid/u.test(error.message) && !error.message.includes(token));
  Object.assign(environment, fixture.environment);
  await storage.configure(fixture.configuration);
  assert.equal(storage.status().find(instance => instance.id === 'source').available, true);
  fixture.configuration.instances[0].config.credentialRef = token + '!';
  await assert.rejects(storage.configure(fixture.configuration), error => /credentialRef/u.test(error.message) && !error.message.includes(token));
  await writeFile(fixture.filename, `{"credentialRef":"${token}", invalid}`);
  await assert.rejects(createConfiguredStorage(fixture.filename), error => error.message === 'Storage configuration contains invalid JSON.');
  fixture.configuration.instances[0].config.credentialRef = 'ISOLATED_ALIST_TOKEN';
  fixture.configuration.instances[0].config.token = token;
  await assert.rejects(storage.configure(fixture.configuration), /unsupported fields/u);
  assert.equal(fixture.calls.length, 0);
});

test('configured WebDAV instances keep credentials, roots and mount capabilities independent', async t => {
  const fixture = await setupWebDav(t);
  const storage = await createConfiguredStorage(fixture.filename, { environment: fixture.environment });
  t.after(() => storage.close());

  assert.equal((await storage.vfs.stat('/first/movie.bin')).size, 4n);
  assert.equal((await storage.vfs.stat('/second/clip.bin')).size, 4n);
  assert.equal(fixture.calls[0].url, '/dav-a/library/movie.bin');
  assert.equal(fixture.calls[0].authorization, fixture.environment.DAV_A_AUTH);
  assert.equal(fixture.calls[1].url, '/dav-b/archive/clip.bin');
  assert.equal(fixture.calls[1].authorization, fixture.environment.DAV_B_AUTH);
  assert.equal(storage.vfs.capabilities('/first/new.bin').create, true);
  assert.equal(storage.vfs.capabilities('/first/new.bin').replace, false);
  assert.equal(storage.vfs.capabilities('/second/new.bin').create, false);

  await storage.vfs.write('/first/new.bin', Buffer.from('new'), { overwrite: false });
  assert.equal(fixture.calls.at(-1).method, 'PUT');
  assert.equal(fixture.calls.at(-1).authorization, fixture.environment.DAV_A_AUTH);
  const calls = fixture.calls.length;
  await assert.rejects(storage.vfs.write('/first/new.bin', Buffer.from('replace')), { code: 'not-supported' });
  await assert.rejects(storage.vfs.write('/second/new.bin', Buffer.from('create'), { overwrite: false }), { code: 'not-supported' });
  assert.equal(fixture.calls.length, calls);
});

test('WebDAV configuration rejects unsupported fields, missing credentials and mount capability elevation', async t => {
  const fixture = await setupWebDav(t);
  const environment = { DAV_A_AUTH: fixture.environment.DAV_A_AUTH };
  const storage = await createConfiguredStorage(fixture.filename, { environment });
  t.after(() => storage.close());
  assert.equal(storage.status().find(instance => instance.id === 'dav-b').available, false);
  const configure = () => storage.configure(fixture.configuration);

  await assert.rejects(configure(), /missing or invalid/u);
  Object.assign(environment, fixture.environment);
  fixture.configuration.instances[1].config.credentialRef = 'DAV_B_AUTH';
  fixture.configuration.instances[0].config.username = 'legacy-user';
  await assert.rejects(configure(), /unsupported fields/u);
  delete fixture.configuration.instances[0].config.username;
  fixture.configuration.instances[0].config.capabilities = { write: true };
  await assert.rejects(configure(), /capabilities/u);
  fixture.configuration.instances[0].config.capabilities = { create: true, replace: true };
  delete fixture.configuration.mounts[0].capabilities;
  await assert.rejects(configure(), /capabilities object/u);
  fixture.configuration.mounts[0].capabilities = { delete: true };
  await assert.rejects(configure(), /cannot exceed/u);
  assert.equal(fixture.calls.length, 0);
});

async function isolatedInstance(fixture, t) {
  const directory = path.join(fixture.directory, 'instance');
  const databasePath = path.join(directory, 'data/data/jellyfin.db');
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(path.join(directory, 'config'));
  await writeFile(path.join(directory, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><EnableLegacyAuthorization>true</EnableLegacyAuthorization></ServerConfiguration>');
  await writeFile(path.join(directory, 'config/network.xml'), '<NetworkConfiguration><AutoDiscovery>false</AutoDiscovery></NetworkConfiguration>');
  await writeFile(path.join(directory, 'data/data/device.txt'), '0123456789abcdef0123456789abcdef');
  const source = new SqliteDatabase(process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE, { readOnly: true, requireMigrationHistory: true });
  try { await source.snapshot(databasePath); } finally { source.close(); }
  const database = new SqliteDatabase(databasePath);
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `runtime_bootstrap_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let postgres;
  try {
    // Keep the pinned native schema/history while making this production fixture
    // contain only paths governed by its one explicit portable mount.
    database.database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.database.exec('BEGIN');
      for (const table of nativeModel.tables) database.database.exec(`DELETE FROM ${q(table.name)}`);
      database.database.exec('COMMIT');
    } catch (error) {
      database.database.exec('ROLLBACK');
      throw error;
    } finally { database.database.exec('PRAGMA foreign_keys = ON'); }
    const item = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : '']));
    database.insert('BaseItems', { ...item, Id: mediaId, Path: 'Z:\\Isolated\\media.wav', Name: 'Isolated file', MediaType: 'Audio', Type: 'MediaBrowser.Controller.Entities.Audio.Audio', RunTimeTicks: 1000000n, Data: '{"Container":"wav"}' });
    database.insert('ApiKeys', { AccessToken: clientToken, Name: 'Isolated client', DateCreated: '2026-09-26 00:00:00', DateLastActivity: '2026-09-26 00:00:00' });
    postgres = await PostgresDatabase.open({ connectionString, schema, create: true });
    t.after(async () => {
      const cleanup = await PostgresDatabase.open({ connectionString, schema });
      try { await cleanup.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
      finally { await cleanup.close(); }
    });
    await transferDatabase(database, postgres, { instanceBinding: {
      serverId: '0123456789abcdef0123456789abcdef',
      originIdentityDigest: 'a'.repeat(64)
    }, portableMountContract });
  } finally {
    database.close();
    await postgres?.close();
  }
  return { ...fixture.environment, MEDIAMANAGER_INSTANCE: directory, MEDIAMANAGER_STORAGE: fixture.filename,
    MEDIAMANAGER_POSTGRES: connectionString, MEDIAMANAGER_POSTGRES_SCHEMA: schema, MEDIAMANAGER_PORT: '0' };
}

test('production entry uses PostgreSQL and configured storage, then closes active raw reads before HTTP shutdown', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE || !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 30000
}, async t => {
  const fixture = await setup(t);
  const environment = await isolatedInstance(fixture, t);
  const errors = [];
  const application = await startProductionInstance({ environment, onError: error => errors.push(error.message) });
  t.after(() => application.close());
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  const headers = { Authorization: `MediaBrowser Token="${clientToken}"` };
  const response = await fetch(`${origin}/Items/${mediaId.replaceAll('-', '')}/File`, { headers });
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  fixture.slow();
  const ongoing = await fetch(`${origin}/Items/${mediaId.replaceAll('-', '')}/File`, { headers });
  const reader = ongoing.body.getReader();
  assert.equal((await reader.read()).value.length, 1);
  const remainder = reader.read().catch(error => error);
  await application.close(); await application.close();
  const interrupted = await remainder;
  assert.ok(interrupted instanceof Error || interrupted.done);
  assert.equal(application.server.listening, false);
  assert.equal(errors.some(message => message.includes(token)), false);
  const reopened = await PostgresDatabase.open({ connectionString: environment.MEDIAMANAGER_POSTGRES,
    schema: environment.MEDIAMANAGER_POSTGRES_SCHEMA });
  await reopened.close();
});

test('production startup returns port errors and releases PostgreSQL resources for a subsequent start', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE || !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 30000
}, async t => {
  const fixture = await setup(t);
  const environment = await isolatedInstance(fixture, t);
  await assert.rejects(startProductionInstance({ environment: { ...environment, MEDIAMANAGER_PORT: '-1' } }), /MEDIAMANAGER_PORT/u);
  const occupied = http.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => { if (occupied.listening) return new Promise(resolve => occupied.close(resolve)); });
  await assert.rejects(startProductionInstance({ environment: { ...environment, MEDIAMANAGER_PORT: String(occupied.address().port) } }), { code: 'EADDRINUSE' });
  await new Promise(resolve => occupied.close(resolve));
  const retry = await startProductionInstance({ environment });
  await retry.close();
});
