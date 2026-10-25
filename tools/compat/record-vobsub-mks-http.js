import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) throw new Error('Usage: node tools/compat/record-vobsub-mks-http.js <new-evidence-directory> <loopback-port>');

const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (outputRoot === allowedRoot || !outputRoot.startsWith(allowedRoot + path.sep)) throw new Error('The evidence directory must be a new child of the configured validation output root.');
if (existsSync(outputRoot)) throw new Error(`Evidence directory already exists: ${outputRoot}`);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5244) throw new Error('The isolated port must be an integer from 1024 through 65535 other than 5244.');

const sourceRoot = validationPath(path.join(repoRoot, '.test-input/evidence/subtitle-manifest-20260927/reference'));
const sourceDatabase = path.join(sourceRoot, 'initial.db');
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const mediaRoot = path.join(outputRoot, 'media');
const dotnetPath = validationExecutable('dotnet');
const jellyfinDll = validationPath(path.join(repoRoot, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const ffmpegPath = validationExecutable('ffmpeg');
const ffprobePath = validationExecutable('ffprobe');
const origin = `http://127.0.0.1:${port}`;
const itemId = '22222222222222222222222222222222';
const itemDatabaseId = '22222222-2222-2222-2222-222222222222';
const password = 'isolated-core-flow-password';
const virtualPath = 'Z:/VobSub/source.mkv';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function available(localPort) {
  return await new Promise(resolve => {
    const server = createNetServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: localPort, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}

async function prepareReference() {
  await mkdir(outputRoot, { recursive: false });
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      if (relative.startsWith('log/') || relative.startsWith('cache/')) return false;
      return !/^(?:initial\.db|stdout\.log|stderr\.log|data\/data\/jellyfin\.db(?:-wal|-shm)?)$/u.test(relative);
    }
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await mkdir(path.join(referenceRoot, 'cache'), { recursive: true });
  await mkdir(path.dirname(databasePath), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });
  for (const file of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let text = await readFile(file, 'utf8');
    text = text.replaceAll(sourceRoot, referenceRoot).replaceAll(sourceRoot.replaceAll('\\', '/'), referenceRoot.replaceAll('\\', '/'));
    if (path.basename(file).toLowerCase() === 'network.xml') {
      text = text.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_match, name) => `<${name}>${port}</${name}>`);
      text = text.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, text);
  }
}

async function prepareMedia() {
  await mkdir(mediaRoot, { recursive: true });
  const fixture = JSON.parse(await readFile(validationPath(path.join(repoRoot, 'tests/playback/fixtures/graphical-subtitle-reference.json')), 'utf8'));
  const vobSub = fixture.sources.find(entry => entry.name === 'vobsub.mks');
  assert.ok(vobSub, 'The committed VobSub fixture is required.');
  const vobSubBytes = Buffer.from(vobSub.media, 'base64');
  const videoBytes = await readFile(validationPath(path.join(repoRoot, '.test-input/evidence/image-hls-lifecycle-20260926/hls/fixture/source.mkv')));
  const videoPath = path.join(mediaRoot, 'video-source.mkv');
  const subtitlePath = path.join(mediaRoot, 'vobsub-source.mks');
  const combinedPath = path.join(mediaRoot, 'source.mkv');
  await writeFile(videoPath, videoBytes);
  await writeFile(subtitlePath, vobSubBytes);
  const remux = spawnSync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', subtitlePath,
    '-map', '0:v:0', '-map', '0:a', '-map', '1:s:0', '-c', 'copy', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default', combinedPath],
  { windowsHide: true, encoding: 'utf8' });
  assert.equal(remux.status, 0, remux.stderr || remux.stdout);
  const combined = await readFile(combinedPath);
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', combinedPath],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  await writeFile(path.join(outputRoot, 'input-probe.json'), probe.stdout);
  await writeFile(path.join(outputRoot, 'input.json'), json({
    video: { bytes: videoBytes.length, sha256: digest(videoBytes) },
    subtitle: { bytes: vobSubBytes.length, sha256: digest(vobSubBytes) },
    combined: { bytes: combined.length, sha256: digest(combined), virtualPath },
    ffmpeg: remux.args
  }));
  return combined;
}

function seedDatabase(mediaLength) {
  const database = new DatabaseSync(databasePath);
  try {
    const template = database.prepare('SELECT * FROM MediaStreamInfos WHERE ItemId = ? AND StreamIndex = 3').get(itemDatabaseId);
    assert.ok(template, 'The reference subtitle template is required.');
    database.prepare('DELETE FROM MediaStreamInfos WHERE ItemId = ? AND StreamType = 2').run(itemDatabaseId);
    const row = { ...template, StreamIndex: 3, Codec: 'dvdsub', CodecTimeBase: null, TimeBase: '1/1000', Path: null, IsExternal: 0,
      IsDefault: 1, IsForced: 0, IsHearingImpaired: 0, IsOriginal: 0, Language: 'eng', Title: 'VobSub MKS HTTP oracle', Width: 720, Height: 480 };
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO MediaStreamInfos (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(name => row[name]));
    const item = database.prepare('SELECT Data FROM BaseItems WHERE Id = ?').get(itemDatabaseId);
    const data = JSON.parse(item.Data);
    Object.assign(data, { Container: 'mkv', Size: mediaLength, HasSubtitles: true, SubtitleFiles: [] });
    database.prepare('UPDATE BaseItems SET Path = ?, Data = ?, Size = ?, TotalBitrate = ? WHERE Id = ?')
      .run('Z:\\VobSub\\source.mkv', JSON.stringify(data), mediaLength, 600000, itemDatabaseId);
  } finally {
    database.close();
  }
}

function authorization(token) {
  return `MediaBrowser Client="VobSubMksHttpOracle", Device="Isolated", DeviceId="vobsub-mks-http-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
}

function redact(value, token, session) {
  const text = JSON.stringify(value);
  return JSON.parse(text.replaceAll(token ?? '\0', '<token>').replaceAll(session ?? '\0', '<session>'));
}

async function probeBytes(name, bytes) {
  const file = path.join(outputRoot, `${name}.bin`);
  await writeFile(file, bytes);
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: probe.status, stdout: probe.stdout, stderr: probe.stderr };
}

assert.equal(await available(port), true, `Port ${port} is already in use.`);
assert.equal(await available(5244), true, 'The frozen LocalMediaProxy port 5244 is already in use.');
await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
await prepareReference();
const mediaBytes = await prepareMedia();
seedDatabase(mediaBytes.length);

const proxyRequests = [];
const proxy = http.createServer((request, response) => {
  const requested = decodeURIComponent(request.url?.slice('/d/'.length) ?? '');
  proxyRequests.push({ method: request.method, url: request.url, range: request.headers.range, authorization: request.headers.authorization });
  if (!request.url?.startsWith('/d/') || requested.toLowerCase() !== virtualPath.toLowerCase()) { response.writeHead(404); response.end(); return; }
  let start = 0;
  let end = mediaBytes.length - 1;
  const range = request.headers.range && /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
  if (range) {
    start = Number(range[1]);
    if (range[2]) end = Math.min(end, Number(range[2]));
  }
  if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${mediaBytes.length}` }); response.end(); return; }
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Length', String(end - start + 1));
  if (range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${mediaBytes.length}`); }
  response.end(request.method === 'HEAD' ? undefined : mediaBytes.subarray(start, end + 1));
});
proxy.listen(5244, '127.0.0.1');
await once(proxy, 'listening');

const stdoutPath = path.join(outputRoot, 'reference-stdout.log');
const stderrPath = path.join(outputRoot, 'reference-stderr.log');
const stdoutDescriptor = openSync(stdoutPath, 'wx');
const stderrDescriptor = openSync(stderrPath, 'wx');
const child = spawn(dotnetPath, [jellyfinDll, '--datadir', path.join(referenceRoot, 'data'), '--configdir', path.join(referenceRoot, 'config'),
  '--cachedir', path.join(referenceRoot, 'cache'), '--logdir', path.join(referenceRoot, 'log'), '--nowebclient', '--ffmpeg', ffmpegPath],
{ cwd: repoRoot, windowsHide: true, stdio: ['ignore', stdoutDescriptor, stderrDescriptor] });
const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });

let token;
let session;
let cleanShutdown = false;
let scenarioError;
let processResult;
const records = {};
async function capture(name, url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = { url, status: response.status, headers: Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))),
    bytes: bytes.length, sha256: digest(bytes), bodyUtf8: response.ok ? undefined : bytes.toString('utf8'), probe: await probeBytes(name, bytes) };
  records[name] = result;
  return result;
}

try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1_000) }).catch(() => null))?.ok) break;
    if (child.exitCode !== null) throw new Error(`Reference exited before readiness: ${child.exitCode}`);
    if (attempt === 119) throw new Error('Reference did not become ready.');
    await delay(500);
  }
  await delay(2_000);
  const loginResponse = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization() },
    body: JSON.stringify({ Username: 'CoreFlowAdmin', Pw: password }), signal: AbortSignal.timeout(15_000) });
  const loginText = await loginResponse.text();
  assert.equal(loginResponse.status, 200, loginText);
  const login = JSON.parse(loginText);
  token = login.AccessToken;
  const headers = { Authorization: authorization(token), 'Content-Type': 'application/json' };
  const playbackResponse = await fetch(origin + `/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({
    MediaSourceId: itemId,
    SubtitleStreamIndex: 3,
    EnableDirectPlay: true,
    EnableDirectStream: false,
    EnableTranscoding: false,
    DeviceProfile: {
      Name: 'VobSub MKS HTTP oracle',
      MaxStreamingBitrate: 10_000_000,
      DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'h264', AudioCodec: 'aac' }],
      TranscodingProfiles: [],
      ContainerProfiles: [],
      CodecProfiles: [],
      SubtitleProfiles: [{ Format: 'vobsub', Container: 'mks', Method: 'External' }]
    }
  }), signal: AbortSignal.timeout(30_000) });
  const playbackText = await playbackResponse.text();
  assert.equal(playbackResponse.status, 200, playbackText);
  const playback = JSON.parse(playbackText);
  session = playback.PlaySessionId;
  const source = playback.MediaSources[0];
  const subtitle = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === 3);
  assert.ok(subtitle?.DeliveryUrl, 'PlaybackInfo did not advertise the VobSub subtitle URL.');
  records.playbackInfo = { status: playbackResponse.status, source: { Id: source.Id, SupportsDirectPlay: source.SupportsDirectPlay,
    DefaultSubtitleStreamIndex: source.DefaultSubtitleStreamIndex, subtitle } };
  const deliveryUrl = new URL(subtitle.DeliveryUrl, origin);
  await capture('advertised-vobsub', deliveryUrl.href, { Authorization: authorization(token) });
  const manualMks = new URL(deliveryUrl);
  manualMks.pathname = manualMks.pathname.replace(/Stream\.[^/]+$/u, 'Stream.mks');
  await capture('manual-mks', manualMks.href, { Authorization: authorization(token) });
  const shutdown = await fetch(origin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization(token) }, signal: AbortSignal.timeout(15_000) });
  cleanShutdown = shutdown.ok;
} catch (error) {
  scenarioError = { name: error.name, message: error.message, stack: error.stack };
} finally {
  if (!cleanShutdown && token) await fetch(origin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization(token) }, signal: AbortSignal.timeout(5_000) }).catch(() => {});
  processResult = await Promise.race([completion, delay(15_000).then(() => null)]);
  if (!processResult && child.exitCode === null) child.kill();
  if (!processResult) processResult = await Promise.race([completion, delay(5_000).then(() => ({ code: child.exitCode, signal: 'timeout' }))]);
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
}

const sanitized = redact({ records, proxyRequests, scenarioError }, token, session);
await writeFile(path.join(outputRoot, 'native-http.json'), json(sanitized));
await writeFile(path.join(outputRoot, 'provenance.json'), json({
  generatedAt: new Date().toISOString(),
  baseline: { jellyfinDll, sha256: digest(await readFile(jellyfinDll)) },
  sourceFiles: {
    streamBuilder: 'D:/jellyfin/MediaBrowser.Model/Dlna/StreamBuilder.cs:1604-1652',
    streamInfo: 'D:/jellyfin/MediaBrowser.Model/Dlna/StreamInfo.cs:1230-1261',
    subtitleController: 'D:/jellyfin/Jellyfin.Api/Controllers/SubtitleController.cs:213-289',
    subtitleEncoder: 'D:/jellyfin/MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs:119-151,237-257,506-535'
  },
  process: processResult,
  cleanShutdown,
  portInitiallyAvailable: true,
  portFinallyAvailable: await available(port),
  proxyPortFinallyAvailable: await available(5244),
  scenarioError
}));
if (scenarioError) throw Object.assign(new Error(scenarioError.message), { cause: scenarioError });
if (!cleanShutdown || processResult?.code !== 0 || !await available(port) || !await available(5244)) throw new Error('The isolated reference did not cleanly shut down.');
console.log(json(redact(records, token, session)));
