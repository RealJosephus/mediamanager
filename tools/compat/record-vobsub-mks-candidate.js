import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { extractionFixture } from '../../tests/playback/extraction-fixture.js';
import libraryFixture from '../../tests/library/fixtures/reference-media.json' with { type: 'json' };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument] = process.argv.slice(2);
if (!outputArgument) throw new Error('Usage: node tools/compat/record-vobsub-mks-candidate.js <existing-evidence-directory>');
if (!process.env.MEDIAMANAGER_TEST_POSTGRES) throw new Error('An isolated PostgreSQL connection is required.');
const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (!outputRoot.startsWith(allowedRoot + path.sep) || !existsSync(outputRoot)) throw new Error('The evidence directory must already exist below .agent-docs/evidence.');
const outputFile = path.join(outputRoot, 'candidate-http.json');
if (existsSync(outputFile)) throw new Error(`Candidate evidence already exists: ${outputFile}`);

const itemId = '22222222-2222-2222-2222-222222222222';
const itemRouteId = itemId.replaceAll('-', '');
const sourcePath = 'Z:\\Extraction\\source.mkv';
const ffprobePath = validationExecutable('ffprobe');
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function seed(database, mediaLength) {
  for (const [table, rows] of Object.entries(libraryFixture.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows];
    const inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
        value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  await database.update('BaseItems', { Id: itemId }, { Path: sourcePath, Size: BigInt(mediaLength), TotalBitrate: 600000,
    Data: JSON.stringify({ VideoType: 'VideoFile', Container: 'mkv', Size: mediaLength, IsHD: false, IsShortcut: false, HasSubtitles: true, SubtitleFiles: [], RemoteTrailers: [] }) });
  const streams = [
    { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true, IsExternal: false, Width: 320, Height: 240, TimeBase: '1/1000', AverageFrameRate: 29.97003 },
    { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, IsExternal: false, Channels: 2, SampleRate: 44100, TimeBase: '1/1000' },
    { Type: 'Audio', Index: 2, Codec: 'aac', IsDefault: true, IsExternal: false, Channels: 2, SampleRate: 44100, TimeBase: '1/1000' },
    { Type: 'Subtitle', Index: 3, Codec: 'dvdsub', IsDefault: true, IsForced: false, IsExternal: false, IsTextSubtitleStream: false,
      SupportsExternalStream: true, Language: 'eng', Title: 'VobSub MKS HTTP oracle', Width: 720, Height: 480, TimeBase: '1/1000' },
  ];
  for (const stream of streams) await database.insert('MediaStreamInfos', probeStreamRow(itemId, stream));
}

function authorization(token) {
  return `MediaBrowser Client="VobSubMksCandidate", Device="Isolated", DeviceId="vobsub-mks-candidate", Version="1"${token ? `, Token="${token}"` : ''}`;
}

function redact(value, token, session) {
  return JSON.parse(JSON.stringify(value).replaceAll(token ?? '\0', '<token>').replaceAll(session ?? '\0', '<session>'));
}

async function probeBytes(name, bytes) {
  const file = path.join(outputRoot, `candidate-${name}.bin`);
  await writeFile(file, bytes);
  const result = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

const mediaBytes = await readFile(path.join(outputRoot, 'media/source.mkv'));
const fixture = await extractionFixture({ '/source.mkv': mediaBytes });
const schema = `vobsub_mks_${randomBytes(8).toString('hex')}`;
const database = await PostgresDatabase.open({
  connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
  schema,
  create: true,
});
const errors = [];
let runtime;
let token;
let session;
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
  await seed(database, mediaBytes.length);
  runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: libraryFixture.serverId,
    programDataPath: libraryFixture.programDataPath, vfs: fixture.vfs, identityMap: fixture.identityMap,
    onError: error => errors.push({ name: error.name, message: error.message, status: error.status, code: error.code, stack: error.stack }) });
  const user = await runtime.users.createUser({ Name: 'VobSubCandidateAdmin', Password: 'isolated-vobsub-candidate-password' });
  await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const loginResponse = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization() },
    body: JSON.stringify({ Username: 'VobSubCandidateAdmin', Pw: 'isolated-vobsub-candidate-password' }) });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  token = login.AccessToken;
  const headers = { Authorization: authorization(token), 'Content-Type': 'application/json' };
  const playbackResponse = await fetch(origin + `/Items/${itemRouteId}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({
    MediaSourceId: itemRouteId,
    SubtitleStreamIndex: 3,
    EnableDirectPlay: true,
    EnableDirectStream: false,
    EnableTranscoding: false,
    DeviceProfile: {
      Name: 'VobSub MKS candidate',
      MaxStreamingBitrate: 10_000_000,
      DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'h264', AudioCodec: 'aac' }],
      TranscodingProfiles: [],
      ContainerProfiles: [],
      CodecProfiles: [],
      SubtitleProfiles: [{ Format: 'vobsub', Container: 'mks', Method: 'External' }]
    }
  }) });
  const playbackText = await playbackResponse.text();
  assert.equal(playbackResponse.status, 200, playbackText);
  const playback = JSON.parse(playbackText);
  session = playback.PlaySessionId;
  const source = playback.MediaSources[0];
  const subtitle = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === 3);
  assert.ok(subtitle?.DeliveryUrl);
  records.playbackInfo = { status: playbackResponse.status, source: { Id: source.Id, SupportsDirectPlay: source.SupportsDirectPlay,
    DefaultSubtitleStreamIndex: source.DefaultSubtitleStreamIndex, subtitle } };
  const deliveryUrl = new URL(subtitle.DeliveryUrl, origin);
  await capture('advertised-vobsub', deliveryUrl.href, { Authorization: authorization(token) });
  const manualMks = new URL(deliveryUrl);
  manualMks.pathname = manualMks.pathname.replace(/Stream\.[^/]+$/u, 'Stream.mks');
  await capture('manual-mks', manualMks.href, { Authorization: authorization(token) });
  await writeFile(outputFile, json(redact({ records, errors, vfsRequests: fixture.requests }, token, session)));
} finally {
  try {
    if (runtime) await runtime.close();
    else await database.close();
  } finally {
    try {
      const cleanup = await PostgresDatabase.open({
        connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        schema,
      });
      try { await cleanup.client.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
      finally { await cleanup.close(); }
    } finally { await fixture.close(); }
  }
}

console.log(json(redact(records, token, session)));
