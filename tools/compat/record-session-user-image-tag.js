import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-session-user-image-tag.js <new-evidence-directory> <loopback-port>');
}

const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (outputRoot === allowedRoot || !outputRoot.startsWith(allowedRoot + path.sep)) {
  throw new Error('The evidence directory must be a new child of the configured validation output root.');
}
if (existsSync(outputRoot)) throw new Error(`Evidence directory already exists: ${outputRoot}`);

const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The loopback port must be an integer from 1024 through 65535.');

const sourceRoot = validationPath(path.join(repoRoot, '.test-input/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.test-input/evidence/core-flow-20260926/initial.db'));
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const dotnetPath = validationExecutable('dotnet');
const jellyfinDll = validationPath(path.join(repoRoot, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${port}`;
const userId = '5c6b5f77bea94a9a98aafae5909892b7';
const devicePrefix = 'session-user-image-tag-';
const password = 'isolated-core-flow-password';
const pngA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function available(localPort) {
  return await new Promise(resolve => {
    const server = createServer();
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
  await mkdir(outputRoot);
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      if (relative.startsWith('log/')) return false;
      return !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    }
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });

  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let text = await readFile(file, 'utf8');
    for (const source of sourceForms) text = text.replaceAll(source, referenceRoot);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      text = text.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_match, name) => `<${name}>${port}</${name}>`);
      text = text.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, text, { flag: 'w' });
  }
}

function imageRows() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare('SELECT "Id", "LastModified", "Path", "UserId" FROM "ImageInfos" ORDER BY "Id"').all().map(row => ({
      Id: Number(row.Id),
      LastModified: row.LastModified,
      Path: row.Path,
      UserId: row.UserId
    }));
  } finally {
    database.close();
  }
}

function dotnetTicks(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z?$/u.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error(`Unsupported native DateTime representation: ${value}`);
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day) || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)) {
    throw new Error(`Unsupported native DateTime representation: ${value}`);
  }
  return (BigInt(milliseconds) + 62135596800000n) * 10000n + BigInt(fraction.padEnd(7, '0'));
}

function expectedTag(row) {
  const bytes = createHash('md5').update(Buffer.from((row.Path + dotnetTicks(row.LastModified)).toWellFormed(), 'utf16le')).digest();
  const guidBytes = Buffer.from(bytes);
  guidBytes.writeUInt32BE(bytes.readUInt32LE(0), 0);
  guidBytes.writeUInt16BE(bytes.readUInt16LE(4), 4);
  guidBytes.writeUInt16BE(bytes.readUInt16LE(6), 6);
  return guidBytes.toString('hex');
}

function authorization(deviceId, token) {
  return `MediaBrowser Client="SessionUserImageTagOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
assert.equal(await available(port), true, `Port ${port} is already in use`);
await prepareReference();

const initialImageRows = imageRows();
assert.deepEqual(initialImageRows, []);

const stdoutPath = path.join(outputRoot, 'reference-stdout.log');
const stderrPath = path.join(outputRoot, 'reference-stderr.log');
const stdoutDescriptor = openSync(stdoutPath, 'wx');
const stderrDescriptor = openSync(stderrPath, 'wx');
const argumentsList = [
  jellyfinDll,
  '--datadir', path.join(referenceRoot, 'data'),
  '--configdir', path.join(referenceRoot, 'config'),
  '--cachedir', path.join(referenceRoot, 'cache'),
  '--logdir', path.join(referenceRoot, 'log'),
  '--nowebclient'
];
const child = spawn(dotnetPath, argumentsList, {
  cwd: repoRoot,
  windowsHide: true,
  stdio: ['ignore', stdoutDescriptor, stderrDescriptor]
});
const completion = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

const records = [];
const databaseStages = { initial: initialImageRows };
let accessToken;
let scenarioError;
let cleanShutdown = false;
let processResult;

async function request(name, route, { method = 'GET', deviceId = `${devicePrefix}initial`, token, contentType, body } = {}) {
  const headers = { Authorization: authorization(deviceId, token) };
  if (contentType) headers['Content-Type'] = contentType;
  const startedAt = new Date().toISOString();
  const response = await fetch(origin + route, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000)
  });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); }
  catch { bodyJson = undefined; }
  const record = {
    name,
    startedAt,
    request: { method, url: origin + route, headers, body: body ?? null },
    response: {
      status: response.status,
      headers: Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
      bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson })
    }
  };
  records.push(record);
  return record.response;
}

async function waitForReady() {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Reference exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(1_000) });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 4) return;
    } catch { consecutiveSuccesses = 0; }
    await delay(1_000);
  }
  throw new Error('Reference did not become ready within 60 seconds');
}

async function login(name, deviceId) {
  const response = await request(name, '/Users/AuthenticateByName', {
    method: 'POST',
    deviceId,
    contentType: 'application/json',
    body: JSON.stringify({ Username: 'CoreFlowAdmin', Pw: password })
  });
  assert.equal(response.status, 200, `${name} should succeed`);
  return response.bodyJson;
}

async function user(name) {
  const response = await request(name, `/Users/${userId}`, { token: accessToken });
  assert.equal(response.status, 200, `${name} should succeed`);
  return response.bodyJson;
}

async function sessions(name) {
  const response = await request(name, '/Sessions', { token: accessToken });
  assert.equal(response.status, 200, `${name} should succeed`);
  assert.ok(Array.isArray(response.bodyJson));
  return response.bodyJson.filter(session => session.UserId === userId && session.DeviceId.startsWith(devicePrefix));
}

function sessionTags(sessionList) {
  assert.ok(sessionList.length > 0);
  return sessionList.map(session => session.UserPrimaryImageTag ?? null);
}

function sessionTagByDevice(sessionList) {
  return Object.fromEntries(sessionList.map(session => [session.DeviceId, session.UserPrimaryImageTag ?? null]));
}

async function sessionActivity(name, token, deviceId) {
  const response = await request(name, '/Sessions/Capabilities', { method: 'POST', token, deviceId });
  assert.equal(response.status, 204, `${name} should succeed`);
}

let summary;
try {
  await waitForReady();
  const loginInitial = await login('login-initial-no-image', `${devicePrefix}initial`);
  accessToken = loginInitial.AccessToken;
  assert.equal(loginInitial.User.Id, userId);
  assert.equal(loginInitial.SessionInfo.UserPrimaryImageTag ?? null, null);
  const userInitial = await user('user-dto-initial-no-image');
  assert.equal(userInitial.PrimaryImageTag ?? null, null);
  const sessionsInitial = await sessions('sessions-initial-no-image');
  assert.deepEqual(sessionTags(sessionsInitial), sessionsInitial.map(() => null));

  const uploadFirst = await request('upload-first-profile-image', `/UserImage?userId=${userId}`, {
    method: 'POST',
    token: accessToken,
    contentType: 'image/png',
    body: pngA
  });
  assert.equal(uploadFirst.status, 204);
  databaseStages.firstImageBeforeReads = imageRows();
  assert.equal(databaseStages.firstImageBeforeReads.length, 1);
  const firstRow = databaseStages.firstImageBeforeReads[0];
  const firstTag = expectedTag(firstRow);
  await sessionActivity('initial-session-activity-after-first-image', accessToken, `${devicePrefix}initial`);
  const userFirst = await user('user-dto-first-image');
  const loginFirst = await login('login-first-image', `${devicePrefix}first`);
  const sessionsFirst = await sessions('sessions-first-image');
  assert.equal(userFirst.PrimaryImageTag, firstTag);
  assert.equal(loginFirst.User.PrimaryImageTag, firstTag);
  assert.equal(loginFirst.SessionInfo.UserPrimaryImageTag, firstTag);
  assert.deepEqual(sessionTags(sessionsFirst), sessionsFirst.map(() => firstTag));
  databaseStages.firstImageAfterReads = imageRows();
  assert.deepEqual(databaseStages.firstImageAfterReads, databaseStages.firstImageBeforeReads);

  await delay(50);
  const uploadUpdated = await request('upload-updated-profile-image', `/UserImage?userId=${userId}`, {
    method: 'POST',
    token: accessToken,
    contentType: 'image/png',
    body: pngB
  });
  assert.equal(uploadUpdated.status, 204);
  databaseStages.updatedImageBeforeReads = imageRows();
  assert.equal(databaseStages.updatedImageBeforeReads.length, 1);
  const updatedRow = databaseStages.updatedImageBeforeReads[0];
  assert.equal(updatedRow.Path, firstRow.Path);
  assert.notEqual(updatedRow.LastModified, firstRow.LastModified);
  const updatedTag = expectedTag(updatedRow);
  assert.notEqual(updatedTag, firstTag);
  const sessionsUpdatedBeforeActivity = await sessions('sessions-updated-before-activity');
  const updatedBeforeActivityTags = sessionTagByDevice(sessionsUpdatedBeforeActivity);
  assert.equal(updatedBeforeActivityTags[`${devicePrefix}initial`], firstTag);
  assert.equal(updatedBeforeActivityTags[`${devicePrefix}first`], firstTag);
  await sessionActivity('initial-session-activity-after-update', accessToken, `${devicePrefix}initial`);
  const userUpdated = await user('user-dto-updated-image');
  const loginUpdated = await login('login-updated-image', `${devicePrefix}updated`);
  await sessionActivity('first-session-activity-after-update', loginFirst.AccessToken, `${devicePrefix}first`);
  const sessionsUpdated = await sessions('sessions-updated-image');
  assert.equal(userUpdated.PrimaryImageTag, updatedTag);
  assert.equal(loginUpdated.User.PrimaryImageTag, updatedTag);
  assert.equal(loginUpdated.SessionInfo.UserPrimaryImageTag, updatedTag);
  assert.deepEqual(sessionTags(sessionsUpdated), sessionsUpdated.map(() => updatedTag));
  databaseStages.updatedImageAfterReads = imageRows();
  assert.deepEqual(databaseStages.updatedImageAfterReads, databaseStages.updatedImageBeforeReads);

  const deleted = await request('delete-profile-image', `/UserImage?userId=${userId}`, {
    method: 'DELETE',
    token: accessToken
  });
  assert.equal(deleted.status, 204);
  databaseStages.deletedBeforeReads = imageRows();
  assert.deepEqual(databaseStages.deletedBeforeReads, []);
  const sessionsDeletedBeforeActivity = await sessions('sessions-deleted-before-activity');
  const deletedBeforeActivityTags = sessionTagByDevice(sessionsDeletedBeforeActivity);
  assert.deepEqual(Object.values(deletedBeforeActivityTags), Object.values(deletedBeforeActivityTags).map(() => updatedTag));
  await sessionActivity('initial-session-activity-after-delete', accessToken, `${devicePrefix}initial`);
  const userDeleted = await user('user-dto-after-delete');
  await sessionActivity('first-session-activity-after-delete', loginFirst.AccessToken, `${devicePrefix}first`);
  await sessionActivity('updated-session-activity-after-delete', loginUpdated.AccessToken, `${devicePrefix}updated`);
  const loginDeleted = await login('login-after-delete', `${devicePrefix}deleted`);
  const sessionsDeleted = await sessions('sessions-after-delete');
  assert.equal(userDeleted.PrimaryImageTag ?? null, null);
  assert.equal(loginDeleted.User.PrimaryImageTag ?? null, null);
  assert.equal(loginDeleted.SessionInfo.UserPrimaryImageTag ?? null, null);
  assert.deepEqual(sessionTags(sessionsDeleted), sessionsDeleted.map(() => null));
  databaseStages.deletedAfterReads = imageRows();
  assert.deepEqual(databaseStages.deletedAfterReads, databaseStages.deletedBeforeReads);

  summary = {
    passed: true,
    origin,
    userId,
    recordCountBeforeShutdown: records.length,
    stages: {
      initial: { userPrimaryImageTag: null, sessionUserPrimaryImageTags: sessionTags(sessionsInitial) },
      firstImage: {
        row: firstRow,
        expectedMd5Tag: firstTag,
        userPrimaryImageTag: userFirst.PrimaryImageTag,
        loginSessionUserPrimaryImageTag: loginFirst.SessionInfo.UserPrimaryImageTag,
        sessionUserPrimaryImageTags: sessionTags(sessionsFirst),
        readsChangedImageInfos: false
      },
      updatedImage: {
        row: updatedRow,
        expectedMd5Tag: updatedTag,
        userPrimaryImageTag: userUpdated.PrimaryImageTag,
        loginSessionUserPrimaryImageTag: loginUpdated.SessionInfo.UserPrimaryImageTag,
        beforeActivitySessionTags: updatedBeforeActivityTags,
        sessionUserPrimaryImageTags: sessionTags(sessionsUpdated),
        pathChanged: updatedRow.Path !== firstRow.Path,
        lastModifiedChanged: updatedRow.LastModified !== firstRow.LastModified,
        tagChanged: updatedTag !== firstTag,
        readsChangedImageInfos: false
      },
      deleted: {
        imageInfoRows: databaseStages.deletedAfterReads,
        userPrimaryImageTag: null,
        loginSessionUserPrimaryImageTag: null,
        beforeActivitySessionTags: deletedBeforeActivityTags,
        sessionUserPrimaryImageTags: sessionTags(sessionsDeleted),
        readsChangedImageInfos: false
      }
    }
  };
} catch (error) {
  scenarioError = error;
  summary = { passed: false, origin, error: { name: error.name, message: error.message, stack: error.stack } };
} finally {
  if (child.exitCode === null && accessToken) {
    try {
      const shutdown = await request('authenticated-shutdown', '/System/Shutdown', { method: 'POST', token: accessToken });
      cleanShutdown = shutdown.status === 204;
    } catch (error) {
      summary.shutdownRequestError = { name: error.name, message: error.message };
    }
  }
  if (child.exitCode === null) {
    processResult = await Promise.race([completion, delay(20_000).then(() => null)]);
    if (processResult === null) {
      child.kill();
      processResult = await completion;
      summary.forcedTermination = true;
    }
  } else {
    processResult = await completion;
  }
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
}

databaseStages.finalAfterShutdown = imageRows();
const portReleased = await available(port);
summary.recordCount = records.length;
summary.referenceProcess = { pid: child.pid, ...processResult, cleanShutdown, portReleased };
if (!cleanShutdown || !portReleased || processResult?.code !== 0) {
  summary.passed = false;
  scenarioError ??= new Error(`Reference cleanup failed: ${JSON.stringify(summary.referenceProcess)}`);
}

await writeFile(path.join(outputRoot, 'native-http.json'), json({ schemaVersion: 1, origin, records }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'database-stages.json'), json(databaseStages), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });

const sourcePaths = [
  'Emby.Server.Implementations/Session/SessionManager.cs',
  'Jellyfin.Server.Implementations/Users/UserManager.cs',
  'src/Jellyfin.Drawing/ImageProcessor.cs',
  'Jellyfin.Api/Controllers/ImageController.cs',
  'MediaBrowser.Model/Dto/SessionInfoDto.cs',
  'MediaBrowser.Model/Dto/UserDto.cs'
];
const nativeSources = [];
for (const relative of sourcePaths) {
  const file = validationPath(path.join(repoRoot, '.test-input/baselines/jellyfin-current/source', relative));
  nativeSources.push({ path: path.relative(repoRoot, file).replaceAll('\\', '/'), sha256: await sha256(file) });
}

const artifactNames = ['native-http.json', 'database-stages.json', 'summary.json', 'reference-stdout.log', 'reference-stderr.log'];
const artifacts = [];
for (const name of artifactNames) artifacts.push({ path: name, sha256: await sha256(path.join(outputRoot, name)) });
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const dotnetInfo = spawnSync(dotnetPath, ['--info'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const provenance = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  scenario: 'Frozen Jellyfin user profile image tag projection into authentication User/SessionInfo, UserDto, and GET /Sessions across create, overwrite, and delete.',
  isolation: {
    sourceInstance: path.relative(repoRoot, sourceRoot).replaceAll('\\', '/'),
    sourceDatabase: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
    clonedInstance: path.relative(repoRoot, referenceRoot).replaceAll('\\', '/'),
    loopbackOnly: true,
    autoDiscovery: false,
    port,
    frozenInputsWereNotRunInPlace: true,
    syntheticCredentialsAndTokensOnly: true
  },
  command: [path.relative(repoRoot, dotnetPath).replaceAll('\\', '/'), ...argumentsList.map(value => path.isAbsolute(value) ? path.relative(repoRoot, value).replaceAll('\\', '/') : value)],
  runtime: { node: process.version, dotnetInfoExitCode: dotnetInfo.status, dotnetInfo: dotnetInfo.stdout },
  referenceAssemblies: [
    { path: path.relative(repoRoot, jellyfinDll).replaceAll('\\', '/'), sha256: await sha256(jellyfinDll) }
  ],
  nativeSources,
  recorder: {
    path: path.relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    sha256: await sha256(fileURLToPath(import.meta.url))
  },
  preparedInputs: [
    { path: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'), sha256: await sha256(sourceDatabase) },
    { path: path.relative(repoRoot, path.join(referenceRoot, 'config/network.xml')).replaceAll('\\', '/'), sha256: await sha256(path.join(referenceRoot, 'config/network.xml')) }
  ],
  result: { passed: summary.passed, process: summary.referenceProcess },
  artifacts
};
await writeFile(path.join(outputRoot, 'provenance.json'), json(provenance), { flag: 'wx' });

console.log(json({ outputRoot, summary: path.join(outputRoot, 'summary.json'), records: records.length, result: summary.referenceProcess, passed: summary.passed }).trim());
if (scenarioError) throw scenarioError;
