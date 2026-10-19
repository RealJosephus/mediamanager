import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { verifyBaseline } from './verify-baseline.js';
import { assertFreshReferenceOutput, captureReferenceInput, verifyReferenceInput } from './reference-inputs.js';

const [dotnet, dll, ffmpeg, destination, manifestPath] = process.argv.slice(2);
if (![dotnet, dll, ffmpeg, destination, manifestPath].every(Boolean)) {
  throw new Error('Usage: node tools/compat/initialize-reference.mjs DOTNET JELLYFIN_DLL FFMPEG NEW_OUTPUT_DIRECTORY BASELINE_MANIFEST');
}
const outputRoot = path.resolve(destination), root = path.join(outputRoot, 'instance');
for (const executable of [dotnet, dll, ffmpeg]) {
  if (!path.isAbsolute(executable)) throw new Error('Reference executable paths must be absolute.');
}
const manifestBytes = await readFile(manifestPath);
const baseline = JSON.parse(manifestBytes);
const baselineVerified = await verifyBaseline(manifestPath);
const copiedSource = path.resolve(path.dirname(manifestPath), 'source');
assertFreshReferenceOutput(outputRoot, [baseline.source, copiedSource]);
const runtimeBefore = await captureReferenceInput(path.dirname(dll));
async function verifySourceCopy() {
  for (const file of baseline.files) {
    const filename = path.join(copiedSource, file.path);
    let info;
    try { info = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT' || !file.deleted) throw error; }
    if (file.deleted) { if (info) throw new Error('Deleted source copy entry reappeared: ' + file.path); continue; }
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error('Unsupported source copy object: ' + file.path);
    const bytes = await readFile(filename);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('Reference source copy differs from the captured manifest: ' + file.path);
    }
  }
}
const dllRelative = path.relative(await realpath(copiedSource), await realpath(dll));
if (dllRelative === '..' || dllRelative.startsWith('..' + path.sep) || path.isAbsolute(dllRelative)) {
  throw new Error('The native DLL must belong to the verified isolated source copy.');
}
await verifySourceCopy();
await mkdir(root, { recursive: true });
for (const name of ['data', 'config', 'cache', 'log']) await mkdir(path.join(root, name));
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
await writeFile(path.join(root, 'config', 'network.xml'), `<?xml version="1.0" encoding="utf-8"?>
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
let output = '', spawnError, token;
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
child.on('error', error => { spawnError = error; });
const password = randomBytes(32).toString('base64url');
const redact = value => value.replaceAll(password, '[isolated password redacted]').replaceAll(token ?? '\0', '[isolated token redacted]');
const base = `http://127.0.0.1:${port}`;
const observations = [];
async function call(route, { body, auth = false } = {}) {
  const response = await fetch(new URL(route, base), {
    method: body !== undefined || route === '/Startup/Complete' || route === '/System/Shutdown' ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: auth ? `MediaBrowser Token="${token}"`
      : 'MediaBrowser Client="CompatibilityValidation", Device="IsolatedReference", DeviceId="reference-initializer", Version="1.0"' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  observations.push({ route, status: response.status });
  const text = await response.text();
  if (!response.ok) throw new Error(`Reference ${route} returned ${response.status}: ${redact(text).slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}
let report, failure;
try {
  let initialUser;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Reference exited during initialization: ${redact(output.slice(-4000))}`);
    try {
      const response = await fetch(`${base}/Startup/User`, { signal: AbortSignal.timeout(500) });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        initialUser = await response.json();
        observations.push({ route: '/Startup/User', status: response.status });
        break;
      }
      await response.body?.cancel();
    } catch {}
    if (attempt === 299) throw new Error('Reference did not become ready within the bounded startup wait.');
    await delay(200);
  }
  await call('/Startup/User', { body: { Name: initialUser.Name, Password: password } });
  const authentication = await call('/Users/AuthenticateByName', { body: { Username: initialUser.Name, Pw: password } });
  token = authentication.AccessToken;
  await call('/Startup/Configuration', { body: { ServerName: 'IsolatedCompatibilityReference', UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' } });
  await call('/Startup/Complete');
  const info = await call('/System/Info', { auth: true });
  await call('/System/Shutdown', { auth: true });
  let timer;
  try {
    await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reference shutdown timed out.')), 10000); })]);
  } finally { clearTimeout(timer); }
  if (child.exitCode !== 0) throw new Error(`Reference shutdown was unsuccessful: ${child.exitCode}/${child.signalCode}`);
  await verifyBaseline(manifestPath);
  await verifySourceCopy();
  await verifyReferenceInput(path.dirname(dll), runtimeBefore);
  if (!(await readFile(manifestPath)).equals(manifestBytes)) throw new Error('Reference manifest changed during initialization.');
  const filename = path.join(root, 'data', 'data', 'jellyfin.db');
  const database = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
  try {
    report = { createdAt: new Date().toISOString(), root, port, base, initializedFromEmpty: true,
      baseline: { head: baseline.head, contentDigest: baseline.contentDigest, files: baseline.files.length,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), verified: baselineVerified, copiedSource,
        sourceCopyVerifiedBeforeAndAfter: true, runtimeEntriesSha256: runtimeBefore.entriesSha256, runtimeUnchanged: true },
      dotnet, dll, ffmpeg, serverId: info.Id, version: info.Version, observations,
      database: { filename, sha256: createHash('sha256').update(await readFile(filename)).digest('hex'),
        tables: database.schema.tables.length, migrationHistory: database.schema.history.length },
      assemblies: await Promise.all((await readdir(path.dirname(dll))).filter(name => name.endsWith('.dll')).sort().map(async name => ({
        name, sha256: createHash('sha256').update(await readFile(path.join(path.dirname(dll), name))).digest('hex'),
      }))),
      process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stopped: true },
      limitations: ['Empty native instance; no full media library or client acceptance.'] };
  } finally { database.close(); }
} catch (error) { failure = error; }
finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
  await writeFile(path.join(outputRoot, 'initialization.log'), redact(output));
  await writeFile(path.join(outputRoot, 'initialization.json'), `${JSON.stringify(report ?? { failure: redact(String(failure)), observations,
    process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stopped: child.exitCode !== null || child.signalCode !== null } }, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ instance: root, observations, migrationHistory: report.database.migrationHistory, stopped: true }));
