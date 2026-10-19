import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { once } from 'node:events';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tableDefinition } from '../../src/database/model.js';
import { verifyBaseline } from './verify-baseline.js';

const { values } = parseArgs({ options: {
  instance: { type: 'string' }, 'jellyfin-dll': { type: 'string' }, 'plugin-dll': { type: 'string' },
  'baseline-manifest': { type: 'string' }, output: { type: 'string' }, port: { type: 'string' },
  dotnet: { type: 'string', default: process.env.MEDIAMANAGER_DOTNET ?? 'dotnet' },
} });
for (const name of ['instance', 'jellyfin-dll', 'plugin-dll', 'baseline-manifest', 'output', 'port']) {
  if (!values[name]) throw new TypeError(`Supply --${name}.`);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError('An isolated loopback port is required.');
const source = path.resolve(values.instance), output = path.resolve(values.output);
if (output === source || output.startsWith(source + path.sep) || source.startsWith(output + path.sep)) throw new Error('The recording must use a separate output directory.');
try { await access(output); throw new Error('The recording output already exists; use a fresh directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const baseline = await verifyBaseline(path.resolve(values['baseline-manifest']));
const identity = JSON.parse(await readFile(path.join(source, 'initialization.json'), 'utf8'));
assert.equal(identity.process.stopped, true);
assert.equal(identity.baseline.contentDigest, baseline.contentDigest);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dll = path.resolve(values['jellyfin-dll']);
assert.equal(hash(await readFile(dll)), identity.assemblies.find(entry => entry.name === 'jellyfin.dll').sha256);
const assemblyDirectory = path.dirname(dll);
for (const name of ['MediaBrowser.Controller.dll', 'MediaBrowser.Providers.dll']) {
  assert.equal(hash(await readFile(path.join(assemblyDirectory, name))), identity.assemblies.find(entry => entry.name === name).sha256);
}
await mkdir(output, { recursive: true });
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const ids = Array.from({ length: 4 }, (_, index) => `F2111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`);
const oldStamp = '2026-09-26 10:00:00';
const results = [];
const withTimeout = async promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The native instance did not exit.')), 30000);
  })]).finally(() => clearTimeout(timer));
};
const until = async operation => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) && error.name !== 'TypeError') throw error; }
    await delay(50);
  }
  throw new Error('The native HTTP refresh observation timed out.');
};
for (const name of ['blocked-queue', 'provider-cancellation', 'shutdown']) {
  const directory = path.join(output, name);
  await cp(source, directory, { recursive: true, errorOnExist: true, force: false });
  const control = path.join(directory, 'control');
  await mkdir(control);
  await writeFile(path.join(control, 'control.json'), JSON.stringify({ Block: 'refresh-control-0', Cancel: name === 'provider-cancellation' ? 'refresh-control-0' : null }));
  const pluginDirectory = path.join(directory, 'data', 'plugins', 'ControlledRefresh_1.0.0.0');
  await mkdir(pluginDirectory, { recursive: true });
  await cp(path.resolve(values['plugin-dll']), path.join(pluginDirectory, 'RefreshHttpPlugin.dll'));
  await writeFile(path.join(pluginDirectory, 'meta.json'), JSON.stringify({ name: 'Controlled refresh diagnostics', guid: '01234567-1234-1234-1234-123456789012',
    version: '1.0.0.0', targetAbi: '13.0.0.0', status: 'Active', autoUpdate: false, assemblies: ['RefreshHttpPlugin.dll'] }));
  const network = path.join(directory, 'config', 'network.xml');
  await writeFile(network, (await readFile(network, 'utf8')).replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/(InternalHttpPort|PublicHttpPort)>/g, (_, tag) => `<${tag}>${port}</${tag}>`));
  const system = path.join(directory, 'config', 'system.xml');
  await writeFile(system, (await readFile(system, 'utf8')).replace(/(<MetadataOptions>\s*<ItemType>Movie<\/ItemType>[\s\S]*?)<DisabledMetadataFetchers\s*\/>/,
    '$1<DisabledMetadataFetchers><string>TheMovieDb</string><string>The Open Movie Database</string></DisabledMetadataFetchers>'));
  const filename = path.join(directory, 'data', 'data', 'jellyfin.db');
  const database = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const token = randomBytes(24).toString('hex');
  for (const [index, Id] of ids.entries()) await database.insert('BaseItems', { ...empty('BaseItems'), Id,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: `refresh-control-${index}`, Path: '', Data: '{}', IsInMixedFolder: true,
    PresentationUniqueKey: Id.replaceAll('-', '').toLowerCase(), DateLastSaved: oldStamp, DateLastRefreshed: oldStamp });
  await database.insert('ApiKeys', { AccessToken: token, Name: 'Isolated refresh recording', DateCreated: oldStamp, DateLastActivity: oldStamp });
  await database.close();
  const snapshot = async () => {
    const db = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await Promise.all(ids.map(async Id => (await db.rows('BaseItems', { where: { Id } }))[0])); }
    finally { await db.close(); }
  };
  const trace = async () => {
    try { return (await readFile(path.join(control, 'trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const process = spawn(values.dotnet, [dll, '--datadir', path.join(directory, 'data'), '--configdir', path.join(directory, 'config'),
    '--cachedir', path.join(directory, 'cache'), '--logdir', path.join(directory, 'log'), '--nowebclient', '--ffmpeg', identity.ffmpeg],
    { windowsHide: true, env: { ...globalThis.process.env, MEDIAMANAGER_NATIVE_REFRESH_CONTROL: control } });
  const stdout = createWriteStream(path.join(directory, 'server.stdout.log')), stderr = createWriteStream(path.join(directory, 'server.stderr.log'));
  process.stdout.pipe(stdout); process.stderr.pipe(stderr);
  const exited = once(process, 'exit');
  const origin = `http://127.0.0.1:${port}`, headers = { Authorization: `MediaBrowser Token="${token}"` };
  let shutdownResponse;
  try {
    await until(async () => (await fetch(origin + '/System/Info', { headers })).status === 200);
    const before = await snapshot();
    const statuses = [];
    for (let index = 0; index < ids.length; index++) {
      statuses.push((await fetch(`${origin}/Items/${ids[index]}/Refresh?metadataRefreshMode=FullRefresh`, { method: 'POST', headers })).status);
      if (!index) await until(async () => (await trace()).some(entry => entry.phase === 'started'));
    }
    assert.deepEqual(statuses, [204, 204, 204, 204]);
    const beforeRelease = (await trace()).filter(entry => entry.phase === 'started').map(entry => entry.name);
    const beforeRows = await snapshot();
    assert.deepEqual(beforeRows.map(row => [row.Overview, row.DateLastSaved, row.DateLastRefreshed]), before.map(row => [row.Overview, row.DateLastSaved, row.DateLastRefreshed]));
    if (name === 'shutdown') shutdownResponse = (await fetch(origin + '/System/Shutdown', { method: 'POST', headers })).status;
    else {
      await writeFile(path.join(control, 'release'), 'release');
      await until(async () => (await trace()).filter(entry => ['completed', 'cancelled'].includes(entry.phase)).length === ids.length);
      await until(async () => (await snapshot()).filter(row => row.Overview?.startsWith('Provider updated')).length === (name === 'provider-cancellation' ? 3 : 4));
      shutdownResponse = (await fetch(origin + '/System/Shutdown', { method: 'POST', headers })).status;
    }
    assert.equal(shutdownResponse, 204);
    const [exitCode, signalCode] = await withTimeout(exited);
    assert.equal(exitCode, 0);
    const after = await snapshot(), events = await trace();
    const observation = { name, statuses, beforeRelease, order: events.filter(entry => entry.phase === 'started').map(entry => entry.name),
      cancelled: events.filter(entry => entry.phase === 'cancelled').map(entry => entry.name),
      persisted: after.map(row => row.Overview?.startsWith('Provider updated') ?? false),
      savedChanged: after.map((row, index) => row.DateLastSaved !== before[index].DateLastSaved),
      refreshedChanged: after.map((row, index) => row.DateLastRefreshed !== before[index].DateLastRefreshed),
      overviews: after.map(row => row.Overview), shutdownStatus: shutdownResponse, exitCode, signalCode };
    results.push(observation);
    await writeFile(path.join(directory, 'observation.json'), JSON.stringify({ observation, before, after, events }, null, 2) + '\n');
  } finally {
    if (process.exitCode == null && process.signalCode == null) { process.kill(); await exited; }
    await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  }
}
await writeFile(path.join(output, 'native.json'), JSON.stringify(results, null, 2) + '\n');
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ recordedAt: new Date().toISOString(), baseline, sourceInstance: source,
  dotnet: values.dotnet, sdkVersion: (await promisify(execFile)(values.dotnet, ['--version'])).stdout.trim(), dll, dllSha256: hash(await readFile(dll)),
  pluginDll: path.resolve(values['plugin-dll']), pluginSha256: hash(await readFile(values['plugin-dll'])), port,
  scope: 'Actual isolated native HTTP, controlled Movie custom provider, four prior-refreshed pathless items, native SQLite before/after; no media scan, NFO, image, client, SQL-fault or cross-process native oracle.',
}, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: results.length, observations: results }));
