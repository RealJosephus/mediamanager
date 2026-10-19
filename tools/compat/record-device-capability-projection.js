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
  throw new Error('Usage: node tools/compat/record-device-capability-projection.js <new-evidence-directory> <loopback-port>');
}

const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (outputRoot === allowedRoot || !outputRoot.startsWith(allowedRoot + path.sep)) {
  throw new Error('The evidence directory must be a new child of the configured validation output root.');
}
if (existsSync(outputRoot)) throw new Error(`Evidence directory already exists: ${outputRoot}`);

const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The loopback port must be an integer from 1024 through 65535.');

const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const dotnetPath = validationExecutable('dotnet');
const jellyfinDll = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${port}`;
const deviceId = 'device-capability-projection-oracle';
const password = 'isolated-core-flow-password';
const iconUrl = 'https://client.invalid/icons/native-device-capability.png';
const appStoreUrl = 'https://client.invalid/store/native-device-capability';
const defaultDeviceCapabilities = {
  PlayableMediaTypes: [],
  SupportedCommands: [],
  SupportsMediaControl: false,
  SupportsPersistentIdentifier: true
};

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

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      Devices: database.prepare(`SELECT "Id", "UserId", "AccessToken", "AppName", "AppVersion", "DeviceName", "DeviceId",
        "IsActive", "DateCreated", "DateModified", "DateLastActivity" FROM "Devices" ORDER BY "Id"`).all().map(row => ({ ...row })),
      DeviceOptions: database.prepare('SELECT "Id", "DeviceId", "CustomName" FROM "DeviceOptions" ORDER BY "Id"').all().map(row => ({ ...row }))
    };
  } finally {
    database.close();
  }
}

function authorization(token) {
  return `MediaBrowser Client="DeviceCapabilityProjectionOracle", Device="Isolated Projection Device", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
const portInitiallyAvailable = await available(port);
assert.equal(portInitiallyAvailable, true, `Port ${port} is already in use`);
await prepareReference();

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
const databaseStages = {};
let accessToken;
let scenarioError;
let cleanShutdown = false;
let processResult;

async function request(name, route, { method = 'GET', token = accessToken, contentType, body } = {}) {
  const headers = { Authorization: authorization(token) };
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

async function deviceInfo(name) {
  const response = await request(name, `/Devices/Info?id=${encodeURIComponent(deviceId)}`);
  assert.equal(response.status, 200, `${name} should succeed`);
  return response.bodyJson;
}

async function deviceList(name, userId) {
  const response = await request(name, `/Devices?userId=${encodeURIComponent(userId)}`);
  assert.equal(response.status, 200, `${name} should succeed`);
  assert.equal(response.bodyJson.Items.filter(device => device.Id === deviceId).length, 1,
    `${name} should contain the oracle device exactly once`);
  return response.bodyJson;
}

function oracleDevice(deviceList) {
  return deviceList.Items.find(device => device.Id === deviceId);
}

async function session(name) {
  const response = await request(name, `/Sessions?deviceId=${encodeURIComponent(deviceId)}`);
  assert.equal(response.status, 200, `${name} should succeed`);
  assert.equal(response.bodyJson.length, 1, `${name} should contain the oracle session`);
  return response.bodyJson[0];
}

let summary;
try {
  await waitForReady();
  databaseStages.initialBeforeLogin = databaseSnapshot();
  assert.equal(databaseStages.initialBeforeLogin.Devices.some(device => device.DeviceId === deviceId), false);

  const login = await request('login-admin', '/Users/AuthenticateByName', {
    method: 'POST',
    token: undefined,
    contentType: 'application/json',
    body: JSON.stringify({ Username: 'CoreFlowAdmin', Pw: password })
  });
  assert.equal(login.status, 200, 'admin login should succeed');
  accessToken = login.bodyJson.AccessToken;
  const userId = login.bodyJson.User.Id;
  assert.equal(login.bodyJson.SessionInfo.DeviceId, deviceId);
  databaseStages.afterLogin = databaseSnapshot();
  assert.equal(databaseStages.afterLogin.Devices.length, databaseStages.initialBeforeLogin.Devices.length + 1);
  assert.ok(databaseStages.afterLogin.Devices.some(device => device.DeviceId === deviceId));
  assert.deepEqual(databaseStages.afterLogin.DeviceOptions, databaseStages.initialBeforeLogin.DeviceOptions);

  const baselineInfo = await deviceInfo('baseline-device-info');
  const baselineList = await deviceList('baseline-device-list', userId);
  const baselineListDevice = oracleDevice(baselineList);
  assert.equal(baselineInfo.Id, deviceId);
  assert.equal(baselineListDevice.Id, deviceId);
  assert.deepEqual(baselineInfo.Capabilities, defaultDeviceCapabilities);
  assert.deepEqual(baselineListDevice.Capabilities, defaultDeviceCapabilities);
  assert.equal(Object.hasOwn(baselineInfo, 'IconUrl'), false);
  assert.equal(Object.hasOwn(baselineListDevice, 'IconUrl'), false);
  databaseStages.baselineAfterReads = databaseSnapshot();
  assert.deepEqual(databaseStages.baselineAfterReads, databaseStages.afterLogin);

  const fullBody = {
    PlayableMediaTypes: ['Video', 'Audio'],
    SupportedCommands: ['SetVolume', 'PlayMediaSource'],
    SupportsMediaControl: true,
    SupportsPersistentIdentifier: false,
    DeviceProfile: {
      Name: 'Native Device Capability Projection',
      MaxStreamingBitrate: 1234567,
      DirectPlayProfiles: [{ Container: 'mkv', Type: 'Video' }]
    },
    AppStoreUrl: appStoreUrl,
    IconUrl: iconUrl
  };
  const full = await request('post-full-capabilities', '/Sessions/Capabilities/Full', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(fullBody)
  });
  assert.equal(full.status, 204, 'full capability report should succeed');
  databaseStages.afterFullReport = databaseSnapshot();
  assert.deepEqual(databaseStages.afterFullReport, databaseStages.afterLogin);

  const sessionAfterFull = await session('session-after-full-capabilities');
  assert.equal(sessionAfterFull.Capabilities.IconUrl, iconUrl);
  assert.equal(sessionAfterFull.Capabilities.AppStoreUrl, appStoreUrl);
  assert.equal(sessionAfterFull.Capabilities.DeviceProfile.Name, fullBody.DeviceProfile.Name);
  const fullInfo = await deviceInfo('device-info-after-full-capabilities');
  const fullList = await deviceList('device-list-after-full-capabilities', userId);
  const fullListDevice = oracleDevice(fullList);
  assert.deepEqual(fullInfo, { ...baselineInfo, IconUrl: iconUrl });
  assert.deepEqual(fullList, {
    ...baselineList,
    Items: baselineList.Items.map(device => device.Id === deviceId ? { ...device, IconUrl: iconUrl } : device)
  });
  assert.deepEqual(fullInfo.Capabilities, defaultDeviceCapabilities);
  assert.deepEqual(fullListDevice.Capabilities, defaultDeviceCapabilities);
  databaseStages.afterFullReads = databaseSnapshot();
  assert.deepEqual(databaseStages.afterFullReads, databaseStages.afterLogin);

  const simple = await request('post-simple-capabilities-without-icon',
    '/Sessions/Capabilities?playableMediaTypes=Book&supportedCommands=Play&supportsMediaControl=true&supportsPersistentIdentifier=false', {
      method: 'POST'
    });
  assert.equal(simple.status, 204, 'simple capability report should succeed');
  databaseStages.afterSimpleReport = databaseSnapshot();
  assert.deepEqual(databaseStages.afterSimpleReport, databaseStages.afterLogin);

  const sessionAfterSimple = await session('session-after-simple-capabilities');
  assert.equal(Object.hasOwn(sessionAfterSimple.Capabilities, 'IconUrl'), false);
  assert.equal(Object.hasOwn(sessionAfterSimple.Capabilities, 'AppStoreUrl'), false);
  assert.equal(Object.hasOwn(sessionAfterSimple.Capabilities, 'DeviceProfile'), false);
  const clearedInfo = await deviceInfo('device-info-after-simple-capabilities');
  const clearedList = await deviceList('device-list-after-simple-capabilities', userId);
  const clearedListDevice = oracleDevice(clearedList);
  assert.deepEqual(clearedInfo, baselineInfo);
  assert.deepEqual(clearedList, baselineList);
  databaseStages.afterSimpleReads = databaseSnapshot();
  assert.deepEqual(databaseStages.afterSimpleReads, databaseStages.afterLogin);

  summary = {
    passed: true,
    origin,
    userId,
    deviceId,
    portInitiallyAvailable,
    recordCountBeforeShutdown: records.length,
    observations: {
      baselineHasTopLevelIconUrl: Object.hasOwn(baselineInfo, 'IconUrl'),
      fullReportSessionIconUrl: sessionAfterFull.Capabilities.IconUrl,
      fullInfoTopLevelIconUrl: fullInfo.IconUrl,
      fullListTopLevelIconUrl: fullListDevice.IconUrl,
      fullInfoCapabilities: fullInfo.Capabilities,
      fullListCapabilities: fullListDevice.Capabilities,
      appStoreUrlLeakedIntoDeviceCapabilities: Object.hasOwn(fullInfo.Capabilities, 'AppStoreUrl'),
      deviceProfileLeakedIntoDeviceCapabilities: Object.hasOwn(fullInfo.Capabilities, 'DeviceProfile'),
      simpleClearedTopLevelIconUrl: !Object.hasOwn(clearedInfo, 'IconUrl') && !Object.hasOwn(clearedListDevice, 'IconUrl'),
      databaseUnchangedFromLoginThroughSimpleReads: true
    }
  };
} catch (error) {
  scenarioError = error;
  summary = { passed: false, origin, deviceId, portInitiallyAvailable, error: { name: error.name, message: error.message, stack: error.stack } };
} finally {
  if (child.exitCode === null && accessToken) {
    try {
      const shutdown = await request('authenticated-shutdown', '/System/Shutdown', { method: 'POST' });
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

databaseStages.finalAfterShutdown = databaseSnapshot();
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
  'Jellyfin.Api/Controllers/SessionController.cs',
  'Jellyfin.Api/Controllers/DevicesController.cs',
  'Emby.Server.Implementations/Session/SessionManager.cs',
  'Jellyfin.Server.Implementations/Devices/DeviceManager.cs',
  'MediaBrowser.Model/Session/ClientCapabilities.cs',
  'MediaBrowser.Model/Dto/ClientCapabilitiesDto.cs',
  'MediaBrowser.Model/Devices/DeviceInfo.cs',
  'MediaBrowser.Model/Dto/DeviceInfoDto.cs'
];
const nativeSources = [];
for (const relative of sourcePaths) {
  const file = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source', relative));
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
  scenario: 'Frozen Jellyfin ClientCapabilities IconUrl projection into GET /Devices and GET /Devices/Info across full and simple capability reports.',
  isolation: {
    sourceInstance: path.relative(repoRoot, sourceRoot).replaceAll('\\', '/'),
    sourceDatabase: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
    clonedInstance: path.relative(repoRoot, referenceRoot).replaceAll('\\', '/'),
    loopbackOnly: true,
    autoDiscovery: false,
    port,
    portInitiallyAvailable,
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
