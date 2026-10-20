import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { captureSearchHistory, captureSearchOrder } from './emby-search-history-scenario.mjs';
import { captureHomeSections } from './emby-home-sections-scenario.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Official reference capture requires an isolated CI runner.');
const scenario = process.env.MEDIAMANAGER_EMBY_CAPTURE_SCENARIO || 'user-copy';
assert.ok(['user-copy', 'search-history', 'search-order', 'home-sections'].includes(scenario));
const root = await realpath(process.env.MEDIAMANAGER_EMBY_REFERENCE_ROOT);
const temporary = await realpath(process.env.RUNNER_TEMP);
assert.equal(path.dirname(root), temporary);
assert.equal(path.basename(root), 'mediamanager-emby-reference');
const receipts = path.join(root, 'receipts'), packageRoot = path.join(root, 'package');
const instance = path.join(root, 'instance');
const dotnetRoot = await realpath(process.env.DOTNET_ROOT);
const dotnet = path.join(dotnetRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dll = path.join(packageRoot, 'system/EmbyServer.dll');
const input = JSON.parse(await readFile(path.join(receipts, 'reference-input.json'), 'utf8'));
assert.equal(input.status, 'prepared');
assert.equal(input.version, '4.10.1.0');
assert.equal(input.commit, process.env.GITHUB_SHA);
assert.equal(input.runId, process.env.GITHUB_RUN_ID);
assert.equal(input.runAttempt, process.env.GITHUB_RUN_ATTEMPT);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function describe(filename) {
  const stat = await lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'A reference input is not an ordinary file.');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(filename)) digest.update(bytes);
  return { bytes: stat.size, sha256: digest.digest('hex') };
}
async function inventory(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? relative + '/' + entry.name : entry.name;
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) await visit(next);
      else files.push({ path: next, ...await describe(path.join(directory, next)) });
    }
  }
  await visit();
  return { entriesSha256: sha(JSON.stringify(files)), files };
}
const archive = await describe(path.join(root, 'release.zip'));
assert.equal(archive.sha256, input.expectedSha256);
assert.equal(archive.bytes, input.expectedBytes);
const report = { kind: 'actual-emby-http-reference', version: input.version, scenario, input, archive,
  producer: { path: fileURLToPath(import.meta.url), ...await describe(fileURLToPath(import.meta.url)) },
  scenarioProducer: { ...await describe(fileURLToPath(new URL(scenario === 'home-sections'
    ? './emby-home-sections-scenario.mjs' : './emby-search-history-scenario.mjs', import.meta.url))) },
  dotnet: { path: dotnet, ...await describe(dotnet) }, referenceBefore: await inventory(packageRoot),
  mediaTools: await Promise.all(['MEDIAMANAGER_FFMPEG', 'MEDIAMANAGER_FFPROBE'].map(async name => ({ name,
    path: process.env[name], ...await describe(process.env[name]) }))),
  runtimeBefore: { shared: await inventory(path.join(dotnetRoot, 'shared')), host: await inventory(path.join(dotnetRoot, 'host')) },
  requests: [], processes: [], sockets: [], outcome: 'started', candidateCompatibilityValidated: false,
  limitations: ['Isolated official Emby API observations, not a candidate compatibility test or production migration acceptance.'] };
const secrets = new Set(), tokenDevices = new Map(), password = randomBytes(32).toString('base64url');
secrets.add(password);
const redact = value => {
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[isolated credential redacted]');
  return value;
};
await mkdir(instance);
await mkdir(path.join(instance, 'config'));
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
await writeFile(path.join(instance, 'config/system.xml'), `<?xml version="1.0" encoding="utf-8"?>
<ServerConfiguration><IsStartupWizardCompleted>false</IsStartupWizardCompleted>
<HttpServerPortNumber>${port}</HttpServerPortNumber><PublicPort>${port}</PublicPort>
<EnableHttps>false</EnableHttps><EnableUPnP>false</EnableUPnP><EnableAutoUpdate>false</EnableAutoUpdate>
<EnableAutomaticRestart>false</EnableAutomaticRestart><EnableRemoteAccess>false</EnableRemoteAccess>
<AutoRunWebApp>false</AutoRunWebApp><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
</ServerConfiguration>`);
let child, ended, output = '', adminToken, failure;
function launch() {
  const args = [dll, '-programdata', instance, '-noautorunwebapp', '-ffmpeg', process.env.MEDIAMANAGER_FFMPEG,
    '-ffprobe', process.env.MEDIAMANAGER_FFPROBE];
  child = spawn(dotnet, args, {
    cwd: instance, windowsHide: true, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, 'dotnet-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ended = once(child, 'exit'); ended.catch(() => {});
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const record = { pid: child.pid, executable: dotnet, arguments: args };
  report.processes.push(record);
  child.once('exit', (exitCode, signalCode) => Object.assign(record, { exitCode, signalCode, stopped: true }));
}
async function ready() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Official Emby exited during startup: ' + redact(output.slice(-6000)));
    try {
      const response = await fetch(origin + '/emby/System/Info/Public', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const info = await response.json();
        assert.equal(info.Version, input.version);
        return;
      }
      await response.body?.cancel();
    } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    await delay(200);
  }
  throw new Error('Official Emby did not become ready: ' + redact(output.slice(-6000)));
}
async function call(label, route, { token = adminToken, method = 'GET', body, form = false,
  deviceId = tokenDevices.get(token) ?? 'emby-contracts-admin' } = {}) {
  const response = await fetch(origin + '/emby' + route, { method, signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      Authorization: `Emby Client="Compatibility research", Device="Isolated CI", DeviceId="${deviceId}", Version="1.0"${token ? `, Token="${token}"` : ''}` },
    ...(body === undefined ? {} : { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }) });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = JSON.parse(bodyText); } catch {}
  if (bodyJson?.AccessToken) { secrets.add(bodyJson.AccessToken); tokenDevices.set(bodyJson.AccessToken, deviceId); }
  const record = { label, method, route, authenticated: Boolean(token), ...(body === undefined ? {} : { requestBody: body }),
    status: response.status, contentType: response.headers.get('content-type'), bodyText, ...(bodyJson === undefined ? {} : { bodyJson }) };
  report.requests.push(record);
  return record;
}
async function connect(userId, token) {
  const observation = { userId, messages: [], errors: [] };
  report.sockets.push(observation);
  const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/emby?api_key=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(tokenDevices.get(token))}`);
  socket.addEventListener('message', event => {
    try { observation.messages.push(JSON.parse(String(event.data))); }
    catch (error) { observation.errors.push(error.message); }
  });
  socket.addEventListener('close', () => { observation.closed = true; });
  socket.addEventListener('error', event => observation.errors.push(event.message ?? 'Websocket error'));
  let timeout;
  try {
    await Promise.race([new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
    }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Official websocket did not connect.')), 10000); })]);
  } finally { clearTimeout(timeout); }
  return observation;
}
const successful = response => {
  assert.ok(response.status >= 200 && response.status < 300, `${response.label}: ${response.status} ${redact(response.bodyText).slice(0, 1200)}`);
  return response.bodyJson;
};
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await call('graceful-shutdown', '/System/Shutdown', { method: 'POST' }).catch(() => {});
  let timeout;
  try { await Promise.race([ended, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Official Emby shutdown timed out.')), 10000); })]); }
  catch (error) { child.kill('SIGKILL'); await ended; throw error; }
  finally { clearTimeout(timeout); }
}
try {
  launch();
  await ready();
  const startup = successful(await call('startup-user', '/Startup/User'));
  successful(await call('set-isolated-password', '/Startup/User', { method: 'POST', body: { Name: startup.Name, Password: password } }));
  const login = successful(await call('administrator-login', '/Users/AuthenticateByName', { method: 'POST', body: { Username: startup.Name, Pw: password } }));
  adminToken = login.AccessToken;
  successful(await call('startup-configuration', '/Startup/Configuration', { method: 'POST', body: {
    ServerName: 'Isolated Emby interoperability reference', UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en',
  } }));
  successful(await call('complete-startup', '/Startup/Complete', { method: 'POST' }));
  successful(await call('actual-private-info', '/System/Info'));
  const reader = successful(await call('create-reader', '/Users/New', { method: 'POST', body: { Name: 'Controlled reader' }, form: true }));
  const other = successful(await call('create-other-reader', '/Users/New', { method: 'POST', body: { Name: 'Other controlled reader' }, form: true }));
  const readerLogin = successful(await call('reader-login', '/Users/AuthenticateByName', { method: 'POST', deviceId: 'emby-contracts-reader', body: { Username: reader.Name, Pw: '' } }));
  const otherLogin = successful(await call('other-reader-login', '/Users/AuthenticateByName', { method: 'POST', deviceId: 'emby-contracts-other', body: { Username: other.Name, Pw: '' } }));
  const token = readerLogin.AccessToken, user = `/Users/${reader.Id}`;
  await connect(reader.Id, token);
  const targetSocket = await connect(other.Id, otherLogin.AccessToken);
  report.identities = { administrator: login.User.Id, reader: reader.Id, other: other.Id };
  const media = path.join(instance, 'controlled-music');
  await mkdir(media);
  const wave = Buffer.alloc(16044);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(16000, 40);
  const names = ['Controlled audio A.wav', 'Controlled audio B.wav', 'Controlled audio C.wav'];
  for (const name of names) await writeFile(path.join(media, name), wave);
  report.mediaSeed = { names, bytesEach: wave.length, sha256Each: sha(wave), encoding: 'One second of mono PCM silence at 8000 Hz, 16 bits.' };
  successful(await call('add-controlled-library', '/Library/VirtualFolders?name=Controlled%20music&collectionType=music&refreshLibrary=true', {
    method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: media }], EnableRealtimeMonitor: false,
      EnableInternetProviders: false, SaveLocalMetadata: false, MetadataSavers: [],
      TypeOptions: ['Audio', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] })) } },
  }));
  const libraryDeadline = Date.now() + 60000;
  let libraryItems;
  while (true) {
    libraryItems = successful(await call('await-controlled-audio', user + '/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path&Limit=4', { token }));
    if (libraryItems.Items?.length === names.length) break;
    assert.ok(Date.now() < libraryDeadline, 'The official server did not scan the actual controlled audio file.');
    await delay(500);
  }
  await call('actual-library-options', '/Library/VirtualFolders/Query');
  if (scenario.startsWith('search-') || scenario === 'home-sections') {
    const capture = scenario === 'home-sections' ? captureHomeSections : scenario === 'search-order' ? captureSearchOrder : captureSearchHistory;
    await capture({ call, reader, other, token, otherToken: otherLogin.AccessToken,
      items: libraryItems.Items, report, instance, restart: async () => { await stop(); launch(); await ready(); } });
    await stop();
  } else {
    await call('configuration-user-menu', `/web/ConfigurationPages?EnableInUserMenu=true&UserId=${reader.Id}`, { token });
    await call('configuration-reader-unfiltered', '/web/ConfigurationPages', { token });
    await call('configuration-reader-other-user', `/web/ConfigurationPages?EnableInUserMenu=true&UserId=${other.Id}`, { token });
    await call('configuration-reader-invalid-user', '/web/ConfigurationPages?EnableInUserMenu=true&UserId=invalid', { token });
    await call('configuration-reader-invalid-flag', '/web/ConfigurationPages?EnableInUserMenu=invalid', { token });
    const copyOptions = await call('copy-options-admin', '/Users/CopyDataOptions');
    await call('copy-options-reader', '/Users/CopyDataOptions', { token });
    await call('copy-options-anonymous', '/Users/CopyDataOptions', { token: null });
    const sections = await call('home-edit-defaults', user + '/HomeSections?IsEditMode=true', { token });
    for (const mode of ['mobile,desktop', 'tv']) await call('home-display-' + mode, user + '/HomeSections?DisplayMode=' + mode, { token });
    await call('home-other-user-reader', `/Users/${other.Id}/HomeSections`, { token });
    await call('home-anonymous', user + '/HomeSections', { token: null });
    if (sections.status === 200 && Array.isArray(sections.bodyJson)) {
      for (const section of sections.bodyJson.slice(0, 12)) {
        await call('section-items-' + section.Id, user + `/Sections/${section.Id}/Items?Limit=4&RandomSeed=1234567&Fields=BasicSyncInfo,CanDownload,PrimaryImageAspectRatio`, { token });
      }
      if (sections.bodyJson.length) {
        const first = sections.bodyJson[0];
        await call('save-custom-home-name', user + '/HomeSections', { token, method: 'POST', body: { ...first, CustomName: 'Controlled custom name', Subtitle: 'Controlled subtitle' } });
        await call('home-after-save', user + '/HomeSections?IsEditMode=true', { token });
        await call('move-home-section', user + '/HomeSections/Move', { token, method: 'POST', body: { Ids: [sections.bodyJson.at(-1).Id], NewIndex: 0 } });
        await call('home-after-move', user + '/HomeSections?IsEditMode=true', { token });
        await call('delete-home-section', user + '/HomeSections/Delete', { token, method: 'POST', body: { Ids: [first.Id] } });
        await call('home-after-delete', user + '/HomeSections?IsEditMode=true', { token });
      }
    }
    const ids = libraryItems.Items.map(item => item.Id);
    for (const name of ['Controlled collection A', 'Controlled collection B']) {
      const response = await call('create-' + name, '/Collections?Name=' + encodeURIComponent(name), { method: 'POST' });
      if (response.status === 200 && response.bodyJson?.Id) ids.push(response.bodyJson.Id);
    }
    report.identities.items = ids;
    const recent = user + '/Items?Recursive=true&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending&Fields=BasicSyncInfo,DateLastSearched&Limit=10';
    await call('recent-initial', recent, { token });
    for (const id of ids.slice(0, 2)) {
      await call('mark-searched-' + id, user + '/SearchedItems', { token, method: 'POST', body: { Ids: [id], WasSearched: true } });
      await call('items-with-sync-field-' + id, user + '/Items?Ids=' + id + '&Fields=BasicSyncInfo,CanDownload', { token });
      await call('items-without-sync-field-' + id, user + '/Items?Ids=' + id + '&Fields=CanDownload', { token });
    }
    await call('recent-after-mark', recent, { token });
    await call('update-reader-settings', `/UserSettings/${reader.Id}/Partial`, { token, method: 'POST', body: { enableAutoFolderJumpThrough: 'false', customUnknownKey: 'Controlled copy value' } });
    await call('update-target-settings-before-copy', `/UserSettings/${other.Id}/Partial`, { method: 'POST', body: { targetOnlyKey: 'Target value', customUnknownKey: 'Old target value' } });
    await call('update-reader-configuration', user + '/Configuration', { method: 'POST', body: {
      ...reader.Configuration, AudioLanguagePreference: 'zh-CN', SubtitleLanguagePreference: 'ja',
    } });
    const settingsOptions = (copyOptions.bodyJson?.DataOptions ?? []).map(option => option.Id)
      .filter(id => /settings|configuration|home/iu.test(id));
    await call('copy-user-settings', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: settingsOptions } });
    await call('other-settings-after-copy', `/UserSettings/${other.Id}`);
    await call('other-user-after-copy', `/Users/${other.Id}`);
    await call('other-home-after-configuration-copy', `/Users/${other.Id}/HomeSections?IsEditMode=true`);
    await call('copy-with-empty-options', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: [] } });
    await call('copy-with-unknown-option', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['unknown-option'] } });
    await call('copy-with-missing-target', user + '/CopyData', { method: 'POST', body: { ToUserIds: ['00000000000000000000000000001234'], CopyOptions: ['userconfiguration'] } });
    if (ids.length) {
      await call('favorite-source-item', user + '/FavoriteItems/' + ids[0], { token, method: 'POST' });
      await call('played-source-item', user + '/PlayedItems/' + ids[0], { token, method: 'POST' });
      await call('favorite-target-overlap', `/Users/${other.Id}/FavoriteItems/${ids[1]}`, { method: 'POST' });
      await call('favorite-target-only', `/Users/${other.Id}/FavoriteItems/${ids[2]}`, { method: 'POST' });
      await delay(800);
      report.targetMessagesBeforeCopy = targetSocket.messages.length;
      await call('copy-playback-data', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['userdata'] } });
      await delay(800);
      report.targetMessagesAfterCopy = targetSocket.messages.length;
      await call('source-item-user-data', user + '/Items/' + ids[0], { token });
      await call('target-item-user-data', `/Users/${other.Id}/Items/${ids[0]}`);
      await call('target-overlap-after-copy', `/Users/${other.Id}/Items/${ids[1]}`);
      await call('target-only-after-copy', `/Users/${other.Id}/Items/${ids[2]}`);
      await call('target-recent-after-copy', recent.replace(reader.Id, other.Id));
    }
    await call('update-source-policy', user + '/Policy', { method: 'POST', body: {
      ...reader.Policy, EnableContentDownloading: false, EnableLiveTvAccess: false, RemoteClientBitrateLimit: 1234000,
    } });
    await call('copy-user-policy', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['userpolicy'] } });
    await call('target-policy-after-copy', `/Users/${other.Id}`);
    await call('copy-user-settings-as-reader', user + '/CopyData', { token, method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['userconfiguration'] } });
    if (ids.length) await call('unmark-searched', user + '/SearchedItems', { token, method: 'POST', body: { Ids: [ids[0]], WasSearched: false } });
    await call('recent-after-unmark', recent, { token });
    await call('clear-searched', user + '/RecentlySearched/Delete', { token, method: 'POST' });
    await call('recent-after-clear', recent, { token });
    await stop();
    launch();
    await ready();
    await call('home-after-restart', user + '/HomeSections?IsEditMode=true', { token });
    await call('recent-after-restart', recent, { token });
    await stop();
  }
  report.referenceAfter = await inventory(packageRoot);
  assert.equal(report.referenceAfter.entriesSha256, report.referenceBefore.entriesSha256, 'The original server package changed during capture.');
  report.runtimeAfter = { shared: await inventory(path.join(dotnetRoot, 'shared')), host: await inventory(path.join(dotnetRoot, 'host')) };
  assert.equal(report.runtimeAfter.shared.entriesSha256, report.runtimeBefore.shared.entriesSha256, 'The .NET shared runtime changed during capture.');
  assert.equal(report.runtimeAfter.host.entriesSha256, report.runtimeBefore.host.entriesSha256, 'The .NET host changed during capture.');
  for (const tool of report.mediaTools) assert.deepEqual(await describe(tool.path), { bytes: tool.bytes, sha256: tool.sha256 });
  report.outcome = 'captured';
} catch (error) {
  failure = error;
  report.outcome = 'failed'; report.failure = { message: error.message, stack: error.stack };
} finally {
  await stop().catch(error => { failure ??= error; report.shutdownFailure = error.message; });
  report.processesStopped = report.processes.every(process => process.stopped);
  try {
    const logs = path.join(instance, 'logs');
    report.instanceLogs = [];
    for (const entry of await readdir(logs, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:txt|log)$/iu.test(entry.name)) continue;
      const text = await readFile(path.join(logs, entry.name), 'utf8');
      const name = 'instance-' + entry.name;
      await writeFile(path.join(receipts, name), redact(text), { flag: 'wx' });
      report.instanceLogs.push({ name, ...await describe(path.join(receipts, name)) });
    }
    const actualInstance = await realpath(instance);
    assert.equal(path.dirname(actualInstance), root);
    assert.equal(path.basename(actualInstance), 'instance');
    await rm(actualInstance, { recursive: true });
    report.instanceRemoved = true;
  } catch (error) { failure ??= error; report.cleanupFailure = error.message; }
  if (failure) report.outcome = 'failed';
  await writeFile(path.join(receipts, 'server.log'), redact(output), { flag: 'wx' });
  await writeFile(path.join(receipts, 'observations.json'), redact(JSON.stringify(report, null, 2)) + '\n', { flag: 'wx' });
}
if (failure) throw new Error(redact(failure.message));
assert.ok(report.processesStopped);
console.log(JSON.stringify({ outcome: report.outcome, version: report.version, requests: report.requests.length, processesStopped: report.processesStopped }));
