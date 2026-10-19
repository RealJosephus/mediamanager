import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
// Isolated frozen-Jellyfin oracle for Artist name/path and failed-write GETs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { nativeArtistIdentity } from '../../src/library/identity.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) throw new Error('Usage: node tools/compat/record-artist-conflicts.js <new-evidence-directory> <loopback-port>');
const output = validationPath(path.resolve(repo, outputArgument));
const allowedRoot = validationOutputRoot();
if (output === allowedRoot || !output.startsWith(allowedRoot + path.sep) || existsSync(output)) {
  throw new Error('Evidence must be a new child directory of the configured validation output root.');
}
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');
const origin = `http://127.0.0.1:${port}`;
const source = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const reference = path.join(output, 'reference');
const databasePath = path.join(reference, 'data/data/jellyfin.db');
const metadataPath = path.join(reference, 'data/metadata');
const dotnet = validationExecutable('dotnet');
const dll = validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const movieId = '22222222-2222-2222-2222-222222222222';
const password = 'isolated-core-flow-password';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function available() {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

async function prepareReference() {
  await mkdir(output);
  await cp(source, reference, { recursive: true, filter(file) {
    const relative = path.relative(source, file).replaceAll('\\', '/');
    return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
  } });
  await mkdir(path.join(reference, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });
  const sourceForms = [source, source.replaceAll('\\', '/'), source.replaceAll('\\', '\\\\')];
  for (const file of await walk(reference)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const oldPath of sourceForms) content = content.replaceAll(oldPath, reference);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }
  const blocked = nativeArtistIdentity('Blocked', { programDataPath: path.join(reference, 'data'), metadataPath }).Path;
  await mkdir(path.dirname(blocked), { recursive: true });
  await writeFile(blocked, 'regular file prevents Artist directory creation\n', { flag: 'wx' });

  const shadow = nativeArtistIdentity('Shadow', { programDataPath: path.join(reference, 'data'), metadataPath });
  const database = new DatabaseSync(databasePath);
  try {
    const template = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get(movieId.toUpperCase());
    assert.ok(template, 'The frozen core-flow Movie template is required.');
    const row = { ...template, Id: shadow.Id, Name: 'Shadow Collision Movie', CleanName: 'shadow collision movie',
      SortName: 'shadow collision movie', Path: 'Z:\\ArtistConflict\\shadow.mkv',
      PresentationUniqueKey: 'artist-conflict-shadow' };
    const columns = Object.keys(row), quote = name => `"${name.replaceAll('"', '""')}"`;
    database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(name => row[name]));
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
  return { blocked, shadow };
}

function databaseSnapshot(ids) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      baseItemsCount: database.prepare('SELECT COUNT(*) AS count FROM "BaseItems"').get().count,
      watchedRows: ids.map(({ name, id }) => ({ name, id, row: database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get(id) ?? null })),
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally { database.close(); }
}

async function artistTree() {
  const root = path.join(metadataPath, 'artists');
  if (!existsSync(root)) return [];
  const entries = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      entries.push({ path: name, type: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isDirectory() ? {} : { size: (await stat(target)).size, sha256: sha256(await readFile(target)) }) });
      if (entry.isDirectory()) await visit(target, name);
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

const authorization = token => `MediaBrowser Client="ArtistConflictOracle", Device="Isolated", DeviceId="artist-conflict-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, { method, headers: { Accept: 'application/json', Authorization: authorization(token),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = JSON.parse(bodyText); } catch { /* Not JSON. */ }
  return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson }) };
}

function startReference() {
  const stdout = openSync(path.join(output, 'reference-stdout.log'), 'wx');
  const stderr = openSync(path.join(output, 'reference-stderr.log'), 'wx');
  const child = spawn(dotnet, [dll, '--datadir', path.join(reference, 'data'), '--configdir', path.join(reference, 'config'),
    '--cachedir', path.join(reference, 'cache'), '--logdir', path.join(reference, 'log'), '--nowebclient'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', stdout, stderr],
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: { name: error.name, message: error.message } }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, closeDescriptors() { closeSync(stdout); closeSync(stderr); } };
}

async function waitForReady(instance) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode ?? instance.child.signalCode}`);
    }
    try {
      const startupLog = await readFile(path.join(output, 'reference-stdout.log'), 'utf8');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1000) });
      const ready = startupLog.includes('Main: Startup complete') && response.ok;
      await response.body?.cancel();
      if (ready) return;
    }
    catch { /* Wait for native bind. */ }
    await delay(500);
  }
  throw new Error('Frozen reference did not become ready.');
}

assert.equal(await available(), true, 'Loopback port is occupied.');
const inputHashes = { recorderSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  sourceDatabaseSha256: sha256(await readFile(sourceDatabase)), dllSha256: sha256(await readFile(dll)) };
const identities = await prepareReference();
const watched = ['Blocked', 'Mirror/A', 'Shadow'].map(name => ({ name,
  id: nativeArtistIdentity(name, { programDataPath: path.join(reference, 'data'), metadataPath }).Id }));
const stages = { before: { database: databaseSnapshot(watched), artistTree: await artistTree() } };
const records = [];
let instance, token, result, outcomeError;
try {
  instance = startReference();
  await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password } });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  token = login.bodyJson.AccessToken;
  for (const [name, artist] of [['blocked-file', 'Blocked'], ['first-normalized-name', 'Mirror/A'],
    ['same-path-name', 'Mirror:A'], ['wrong-type-id', 'Shadow']]) {
    const route = `/Items?Ids=${movieId}&Artists=${encodeURIComponent(artist)}&Fields=SortName&EnableImages=false&EnableUserData=false`;
    const response = await request(route, { token });
    records.push({ name, artist, route, response });
    stages[name] = { database: databaseSnapshot(watched), artistTree: await artistTree() };
  }
} catch (error) { outcomeError = error; }
finally {
  if (instance) {
    if (token && instance.child.exitCode === null) {
      try { await request('/System/Shutdown', { method: 'POST', token }); }
      catch (error) { outcomeError ??= error; }
    }
    result = await Promise.race([instance.completion, delay(20000).then(() => null)]);
    if (!result && instance.child.exitCode === null) {
      instance.child.kill();
      result = await Promise.race([instance.completion, delay(10000).then(() => null)]);
    }
    instance.closeDescriptors();
  }
  stages.afterShutdown = { database: databaseSnapshot(watched), artistTree: await artistTree() };
  await writeFile(path.join(output, 'native-http.json'), json({ origin, records }), { flag: 'wx' });
  await writeFile(path.join(output, 'stages.json'), json({ schemaVersion: 1, watched, identities, ...stages }), { flag: 'wx' });
  const summary = { passed: !outcomeError && records.length === 4 && result?.code === 0 && await available()
    && Object.values(stages).every(stage => stage.database.foreignKeyCheck.length === 0),
  cases: records.length, processResult: result, portAvailable: await available(), ...inputHashes,
  error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null };
  await writeFile(path.join(output, 'summary.json'), json(summary), { flag: 'wx' });
  if (!summary.passed) throw new Error(`Artist conflict oracle failed: ${JSON.stringify(summary.error ?? summary.processResult)}`);
  console.log(JSON.stringify({ evidence: path.relative(repo, output), cases: records.length, processResult: result, portAvailable: summary.portAvailable }));
}

