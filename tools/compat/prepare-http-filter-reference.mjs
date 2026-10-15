import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { verifyBaseline } from './verify-baseline.js';
import { assertFreshReferenceOutput, captureReferenceInput, verifyReferenceInput } from './reference-inputs.js';

const [dotnet, dll, ffmpeg, destination, manifestPath] = process.argv.slice(2);
if (![dotnet, dll, ffmpeg, destination, manifestPath].every(Boolean)) {
  throw new Error('Usage: node prepare-http-filter-reference.mjs DOTNET JELLYFIN_DLL FFMPEG NEW_INSTANCE BASELINE_MANIFEST');
}
const root = path.resolve(destination), repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
for (const filename of [dotnet, dll, ffmpeg, manifestPath]) assert.equal(path.isAbsolute(filename), true);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineBytes = await readFile(manifestPath), baseline = JSON.parse(baselineBytes);
const baselineVerified = await verifyBaseline(manifestPath);
const copiedSource = path.resolve(path.dirname(manifestPath), 'source');
assertFreshReferenceOutput(root, [baseline.source, copiedSource]);
const resolvedSource = await realpath(copiedSource);
const belongsToSource = filename => {
  const relative = path.relative(resolvedSource, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
assert.ok(belongsToSource(await realpath(dll)), 'The native DLL must belong to the verified isolated source copy.');
async function verifySourceCopy() {
  for (const file of baseline.files) {
    const filename = path.join(copiedSource, file.path);
    let info;
    try { info = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT' || !file.deleted) throw error; }
    if (file.deleted) { assert.equal(info, undefined, `Deleted source copy entry reappeared: ${file.path}`); continue; }
    assert.ok(info?.isFile() && !info.isSymbolicLink() && belongsToSource(await realpath(filename)),
      `Unsupported source copy object: ${file.path}`);
    const bytes = await readFile(filename);
    assert.equal(bytes.length, file.size, `Reference source copy size changed: ${file.path}`);
    assert.equal(hash(bytes), file.sha256, `Reference source copy changed: ${file.path}`);
  }
}
await verifySourceCopy();
const runtimeRoot = path.dirname(dll), runtimeBefore = await captureReferenceInput(runtimeRoot);
const executablesBefore = await Promise.all([dotnet, dll, ffmpeg].map(async filename => ({ path: filename, sha256: hash(await readFile(filename)) })));
const bootstrapScript = { path: fileURLToPath(import.meta.url), sha256: hash(await readFile(fileURLToPath(import.meta.url))) };
const verificationTools = await Promise.all(['verify-baseline.js', 'reference-inputs.js'].map(async name => {
  const filename = fileURLToPath(new URL(name, import.meta.url));
  return { path: filename, sha256: hash(await readFile(filename)) };
}));
const nativeModelPath = path.join(repoRoot, 'src/database/native-model.json'), nativeModelSha256 = hash(await readFile(nativeModelPath));
await mkdir(root, { recursive: true });
for (const name of ['data', 'config', 'cache', 'log']) await mkdir(path.join(root, name));
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
await writeFile(path.join(root, 'config/network.xml'), `<?xml version="1.0" encoding="utf-8"?>
<NetworkConfiguration>
  <InternalHttpPort>${port}</InternalHttpPort><PublicHttpPort>${port}</PublicHttpPort>
  <AutoDiscovery>false</AutoDiscovery><EnableUPnP>false</EnableUPnP>
  <EnableIPv4>true</EnableIPv4><EnableIPv6>false</EnableIPv6>
  <EnableHttps>false</EnableHttps><RequireHttps>false</RequireHttps>
  <EnableRemoteAccess>false</EnableRemoteAccess>
  <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
</NetworkConfiguration>
`);
const args = [dll, '--nowebclient', '--datadir', path.join(root, 'data'), '--configdir', path.join(root, 'config'),
  '--cachedir', path.join(root, 'cache'), '--logdir', path.join(root, 'log'), '--ffmpeg', ffmpeg];
const child = spawn(dotnet, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const ended = once(child, 'exit');
ended.catch(() => {});
let output = '', spawnError, token, createdAdmin;
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
child.on('error', error => { spawnError = error; });
const startupPassword = randomBytes(32).toString('base64url');
const fixturePassword = 'isolated-core-flow-password';
const fixtureUserId = '5C6B5F77-BEA9-4A9A-98AA-FAE5909892B7';
const secretStrings = [startupPassword, fixturePassword];
const redact = value => secretStrings.reduce((result, secret) => result.replaceAll(secret, '[isolated credential redacted]'), String(value));
const observations = [];
async function call(route, { body, auth = false, method } = {}) {
  const response = await fetch(new URL(route, origin), {
    method: method ?? (body !== undefined || ['/Startup/Complete', '/System/Shutdown'].includes(route) ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: auth ? `MediaBrowser Token="${token}"`
      : 'MediaBrowser Client="CompatibilityValidation", Device="IsolatedFilterReference", DeviceId="filter-reference-bootstrap", Version="1.0"' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { rawBody: text }; }
  if (parsed?.AccessToken) secretStrings.push(parsed.AccessToken);
  observations.push({ route, method: method ?? (body !== undefined || ['/Startup/Complete', '/System/Shutdown'].includes(route) ? 'POST' : 'GET'),
    status: response.status, requestBody: body ? JSON.parse(redact(JSON.stringify(body))) : null,
    responseBody: parsed ? JSON.parse(redact(JSON.stringify(parsed))) : null });
  if (!response.ok) throw new Error(`Reference ${route} returned ${response.status}: ${redact(text).slice(0, 1000)}`);
  return parsed;
}
let report, failure;
try {
  let initialUser;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Reference exited: ${redact(output.slice(-4000))}`);
    try {
      const response = await fetch(`${origin}/Startup/User`, { signal: AbortSignal.timeout(500) });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        initialUser = await response.json();
        observations.push({ route: '/Startup/User', method: 'GET', status: response.status, responseBody: initialUser });
        break;
      }
      await response.body?.cancel();
    } catch {}
    if (attempt === 299) throw new Error('Bounded native startup wait expired.');
    await delay(200);
  }
  await call('/Startup/User', { body: { Name: initialUser.Name, Password: startupPassword } });
  const authentication = await call('/Users/AuthenticateByName', { body: { Username: initialUser.Name, Pw: startupPassword } });
  token = authentication.AccessToken;
  await call('/Startup/Configuration', { body: { ServerName: 'IsolatedFilterReference', UICulture: 'en-US',
    MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' } });
  await call('/Startup/Complete');
  createdAdmin = await call('/Users/New', { auth: true, body: { Name: 'CoreFlowAdmin', Password: fixturePassword } });
  await call(`/Users/${createdAdmin.Id}/Policy`, { auth: true,
    body: { ...createdAdmin.Policy, IsAdministrator: true, IsHidden: false } });
  const fixtureAuthentication = await call('/Users/AuthenticateByName', { body: { Username: 'CoreFlowAdmin', Pw: fixturePassword } });
  assert.equal(fixtureAuthentication.User.Id, createdAdmin.Id);
  assert.equal(fixtureAuthentication.User.Policy.IsAdministrator, true);
  token = fixtureAuthentication.AccessToken;
  await call('/System/Shutdown', { auth: true });
  assert.equal(observations.at(-1).status, 204);
  let timer;
  try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native shutdown timed out.')), 10000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  const filename = path.join(root, 'data/data/jellyfin.db');
  const before = await readFile(filename);
  const database = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const changedReferences = [];
  const actualIdKey = createdAdmin.Id.replaceAll('-', '').toLowerCase();
  try {
    assert.equal(database.rows('Users', { where: { Id: fixtureUserId } }).length, 0);
    const nativeAdmin = database.rows('Users').find(row => row.Id.replaceAll('-', '').toLowerCase() === actualIdKey);
    assert.ok(nativeAdmin);
    database.database.exec('PRAGMA foreign_keys=OFF');
    database.transaction(() => {
      // Remap only the API-created synthetic user's Guid references. Password,
      // policy and native migration history remain products of the actual API.
      for (const table of nativeModel.tables) for (const column of table.columns.filter(column => column.clrType.replace('?', '') === 'Guid')) {
        const result = database.database.prepare(`UPDATE ${quoteIdentifier(table.name)} SET ${quoteIdentifier(column.name)}=? WHERE lower(replace(${quoteIdentifier(column.name)}, '-', ''))=?`)
          .run(fixtureUserId, actualIdKey);
        if (result.changes > 0) changedReferences.push({ table: table.name, column: column.name, count: Number(result.changes) });
      }
      const aggregate = database.rows('BaseItems').find(item => item.Type.endsWith('.AggregateFolder'));
      assert.ok(aggregate);
      const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
        column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));
      const folderId = '11111111-1111-1111-1111-111111111111', movieId = '22222222-2222-2222-2222-222222222222';
      const common = { ...empty, DateCreated: '2026-09-20 12:00:00', DateModified: '2026-09-20 12:00:00', DateLastSaved: '2026-09-20 12:00:00',
        ChannelId: '00000000-0000-0000-0000-000000000000', Data: '{}', Genres: '', Tags: '', Studios: '', ProductionLocations: '', TopParentId: folderId };
      database.insert('BaseItems', { ...common, Id: folderId, Type: 'MediaBrowser.Controller.Entities.Folder', ParentId: aggregate.Id,
        Name: 'Core Flow Movies', CleanName: 'core flow movies', SortName: 'core flow movies', IsFolder: true, MediaType: 'Unknown', UnratedType: 'Other', Path: 'Z:\\CoreFlow\\Movies' });
      database.insert('BaseItems', { ...common, Id: movieId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', ParentId: folderId,
        Name: 'Alpha 中文', CleanName: 'alpha 中文', SortName: 'alpha 中文', IsMovie: true, MediaType: 'Video', UnratedType: 'Movie',
        Path: 'Z:\\CoreFlow\\Movies\\Alpha 中文.mkv', RunTimeTicks: 72000000000n, ProductionYear: 2020, CommunityRating: 7.5,
        Overview: 'Alpha 中文 overview', Genres: 'Drama', Data: '{"VideoType":"VideoFile","IsHD":false,"IsShortcut":false,"RemoteTrailers":[]}' });
      database.insert('AncestorIds', { ItemId: folderId, ParentItemId: aggregate.Id });
      database.insert('AncestorIds', { ItemId: movieId, ParentItemId: folderId });
      database.insert('AncestorIds', { ItemId: movieId, ParentItemId: aggregate.Id });
    });
    database.database.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(database.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.rows('Users', { where: { Id: fixtureUserId } })[0].Username, 'CoreFlowAdmin');
    const initialDatabase = path.join(root, 'initial.db');
    await database.snapshot(initialDatabase);
    const baselineAfter = await verifyBaseline(manifestPath);
    await verifySourceCopy();
    await verifyReferenceInput(runtimeRoot, runtimeBefore);
    assert.ok((await readFile(manifestPath)).equals(baselineBytes), 'Reference manifest changed during preparation.');
    for (const entry of [...executablesBefore, bootstrapScript, ...verificationTools]) {
      assert.equal(hash(await readFile(entry.path)), entry.sha256, `Reference preparation input changed: ${entry.path}`);
    }
    assert.equal(hash(await readFile(nativeModelPath)), nativeModelSha256, 'Native model changed during preparation.');
    report = { createdAt: new Date().toISOString(), initializedFromEmpty: true, root, port, origin,
      baseline: { head: baseline.head, contentDigest: baseline.contentDigest, files: baseline.files.length,
        manifestPath, manifestSha256: hash(baselineBytes), verifiedBefore: baselineVerified, verifiedAfter: baselineAfter,
        copiedSource, sourceCopyVerifiedBeforeAndAfter: true, runtimeRoot,
        runtimeEntriesSha256: runtimeBefore.entriesSha256, runtimeUnchanged: true },
      outputResolvedInsideWorkspaceTemporary: true,
      executables: executablesBefore, executablesUnchanged: true, bootstrapScript, verificationTools,
      nativeModelSha256, observations,
      identityRemapping: { createdThroughNativeApi: true, actualUserId: createdAdmin.Id, fixtureUserId, changedReferences,
        scope: 'Stopped isolated database: only Guid-column references to the API-created synthetic admin are remapped; native password hashing and permission records are retained.' },
      sourceDatabaseSha256BeforeOfflinePreparation: hash(before), initialDatabase,
      initialDatabaseSha256: hash(await readFile(initialDatabase)), templates: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
      migrationHistory: database.schema.history.length, foreignKeyCheck: [],
      process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stopped: true },
      limitations: ['Synthetic input templates; no real media scanning or bytes.', 'Offline synthetic identity remapping is declared; this is not a replay of the vanished historical source instance.'],
    };
  } finally { database.close(); }
} catch (error) { failure = error; }
finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
  await writeFile(path.join(root, 'bootstrap.log'), redact(output));
  await writeFile(path.join(root, 'bootstrap.json'), JSON.stringify(report ?? { failure: redact(String(failure)), observations,
    process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stopped: child.exitCode !== null || child.signalCode !== null } }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ instance: root, observations: observations.map(({ route, status }) => ({ route, status })),
  identityRemapped: true, templates: 2, migrationHistory: report.migrationHistory, initialDatabase: report.initialDatabase, stopped: true }));
