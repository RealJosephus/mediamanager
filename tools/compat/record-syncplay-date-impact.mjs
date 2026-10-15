// Records the minimum-year SyncPlay Ready behavior through frozen Jellyfin's
// real HTTP/WebSocket entry points. The output is intentionally a raw capture
// plus a small behavior contract; no expected response fixture is an input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(process.env.MEDIAMANAGER_REPOSITORY_ROOT || process.cwd());
const validation = await import(pathToFileURL(path.join(repoRoot, 'tools/validation/paths.js')));
const preparationModule = await import(pathToFileURL(path.join(repoRoot, 'tools/compat/filter-reference-inputs.mjs')));
const scenarioModule = await import(pathToFileURL(path.join(repoRoot, 'tests/sessions/syncplay-date-impact-scenario.js')));
const databaseModule = await import(pathToFileURL(path.join(repoRoot, 'src/database/sqlite.js')));
const transferModule = await import(pathToFileURL(path.join(repoRoot, 'src/migration/database-transfer.js')));
const modelModule = await import(pathToFileURL(path.join(repoRoot, 'src/database/model.js')));
const { assertValidationOutputChild, validationExecutable, validationPath } = validation;
const { captureFilterReferencePreparation } = preparationModule;
const { normalizeSyncPlayDateImpact, recordSyncPlayDateImpact, syncPlayDateImpactCases } = scenarioModule;
const { SqliteDatabase } = databaseModule;
const { databaseDigest } = transferModule;
const { nativeModel } = modelModule;

const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-syncplay-date-impact.mjs <new-evidence-root> <preferred-loopback-port>');
}
const evidenceRoot = assertValidationOutputChild(path.resolve(repoRoot, outputArgument));
if (existsSync(evidenceRoot)) throw new Error('The SyncPlay evidence root must not already exist.');
if (path.basename(evidenceRoot) !== 'syncplay-date-impact-native-v1') {
  throw new Error('The evidence root must be named syncplay-date-impact-native-v1.');
}
const preferredPort = Number(portArgument);
if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
  throw new Error('The preferred loopback port must be an integer from 1024 through 65535.');
}

const nativeRun = path.join(evidenceRoot, 'native-run');
const referenceRoot = path.join(nativeRun, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const baselineRoot = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current'));
const baselineSource = path.join(baselineRoot, 'source');
const baselineManifestPath = path.join(baselineRoot, 'manifest.json');
const jellyfinDll = process.env.MEDIAMANAGER_JELLYFIN_DLL
  ? path.resolve(repoRoot, process.env.MEDIAMANAGER_JELLYFIN_DLL)
  : path.join(baselineSource, 'Jellyfin.Server/bin/Release/net10.0/jellyfin.dll');
const dotnet = validationExecutable('dotnet');
const recorderPath = path.join(repoRoot, 'tools/compat/record-syncplay-date-impact.mjs');
const scenarioPath = path.join(repoRoot, 'tests/sessions/syncplay-date-impact-scenario.js');
const recordedRecorderPath = path.join(evidenceRoot, 'record-native.mjs');
const recordedScenarioPath = path.join(evidenceRoot, 'scenario.js');
const stdoutPath = path.join(nativeRun, 'reference-stdout.log');
const stderrPath = path.join(nativeRun, 'reference-stderr.log');
const waitingStatePath = path.join(baselineSource, 'MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs');
const nativeGroupPath = path.join(baselineSource, 'Emby.Server.Implementations/SyncPlay/Group.cs');
const controllerPath = path.join(baselineSource, 'Jellyfin.Api/Controllers/SyncPlayController.cs');
const candidateGroupPath = path.join(repoRoot, 'src/syncplay/group.js');
const candidateDatePath = path.join(repoRoot, 'src/http/json-date-time.js');

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $integer: item.toString() } : item, 2) + '\n';
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $integer: item.toString() } : item);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256File = async filename => sha256Bytes(await readFile(filename));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

async function portAvailable(port) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function choosePort(start) {
  for (let port = start; port <= Math.min(65535, start + 100); port++) if (await portAvailable(port)) return port;
  throw new Error(`No free loopback port from ${start} through ${Math.min(65535, start + 100)}.`);
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else files.push(filename);
  }
  return files;
}

async function prepareReference(port) {
  await mkdir(nativeRun, { recursive: true });
  await cp(recorderPath, recordedRecorderPath, { errorOnExist: true, force: false });
  await cp(scenarioPath, recordedScenarioPath, { errorOnExist: true, force: false });
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      if (relative.startsWith('log/')) return false;
      return !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    },
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { errorOnExist: true, force: false });
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const filename of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(filename)) continue;
    let content = await readFile(filename, 'utf8');
    for (const source of sourceForms) content = content.replaceAll(source, referenceRoot);
    if (path.basename(filename).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu,
        (_match, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    if (path.basename(filename).toLowerCase() === 'logging.default.json') {
      const logging = JSON.parse(content);
      logging.Serilog.MinimumLevel.Override['MediaBrowser.Controller.SyncPlay.GroupStates.WaitingGroupState'] = 'Debug';
      content = JSON.stringify(logging, null, 2) + '\n';
    }
    await writeFile(filename, content);
  }
}

function startReference(port) {
  const stdout = openSync(stdoutPath, 'wx');
  const stderr = openSync(stderrPath, 'wx');
  const child = spawn(dotnet, [jellyfinDll,
    '--datadir', path.join(referenceRoot, 'data'),
    '--configdir', path.join(referenceRoot, 'config'),
    '--cachedir', path.join(referenceRoot, 'cache'),
    '--logdir', path.join(referenceRoot, 'log'),
    '--nowebclient'], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: { name: error.name, message: error.message } }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, port, closeDescriptors() { closeSync(stdout); closeSync(stderr); } };
}

async function waitForReady(instance, origin) {
  let consecutiveHttpSuccesses = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen Jellyfin exited before readiness: ${instance.child.exitCode ?? instance.child.signalCode}`);
    }
    try {
      const startupLog = await readFile(stdoutPath, 'utf8');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1000) });
      const startupComplete = startupLog.includes('Main: Startup complete');
      consecutiveHttpSuccesses = response.ok ? consecutiveHttpSuccesses + 1 : 0;
      await response.body?.cancel();
      if (startupComplete && consecutiveHttpSuccesses >= 3) {
        return { startupComplete: true, consecutiveHttpSuccesses, attempts: attempt + 1 };
      }
    } catch { consecutiveHttpSuccesses = 0; /* Keep waiting for the isolated loopback listener. */ }
    await delay(500);
  }
  throw new Error('Frozen Jellyfin did not reach Main: Startup complete within the bounded wait.');
}

function processExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function databaseSnapshot() {
  const database = new SqliteDatabase(databasePath, { readOnly: true });
  try {
    return {
      tables: await databaseDigest(database),
      foreignKeyCheck: database.database.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally { database.close(); }
}

async function scanLogicalDatabase(needles) {
  const database = new SqliteDatabase(databasePath, { readOnly: true });
  try {
    const matches = [];
    for (const table of nativeModel.tables) {
      let offset = 0;
      for (;;) {
        const rows = await database.rows(table.name, { limit: 500, offset });
        for (const row of rows) {
          const encoded = stable(row);
          for (const needle of needles) if (encoded.includes(needle)) matches.push({ table: table.name, needle });
        }
        offset += rows.length;
        if (rows.length < 500) break;
      }
    }
    return matches;
  } finally { database.close(); }
}

async function authenticatedRequest(origin, route, token, method = 'GET') {
  const response = await fetch(origin + route, {
    method,
    headers: { Authorization: `MediaBrowser Client="SyncPlayDateImpactRecorder", Device="Isolated", DeviceId="syncplay-date-impact-a", Version="1", Token="${token}"` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return { status: response.status, bodyText: text };
}

async function forceProcessTreeExit(instance) {
  let result = await Promise.race([instance.completion, delay(20000).then(() => null)]);
  if (result) return result;
  if (process.platform === 'win32' && instance.child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(instance.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => killer.once('exit', resolve));
  } else instance.child.kill('SIGKILL');
  result = await Promise.race([instance.completion, delay(10000).then(() => null)]);
  return result;
}

const selectedPort = await portAvailable(preferredPort) ? preferredPort : await choosePort(preferredPort + 1);
const origin = `http://127.0.0.1:${selectedPort}`;
const preparation = await captureFilterReferencePreparation({
  sourceRoot,
  sourceDatabase,
  repoRoot,
  fixtureUserId: '5c6b5f77-bea9-4a9a-98aa-fae5909892b7',
});
const baselineManifestBytes = await readFile(baselineManifestPath);
const baselineManifest = JSON.parse(baselineManifestBytes);
const sourceTexts = {
  waiting: await readFile(waitingStatePath, 'utf8'),
  group: await readFile(nativeGroupPath, 'utf8'),
  controller: await readFile(controllerPath, 'utf8'),
};
assert.match(sourceTexts.waiting, /if \(Math\.Abs\(elapsedTime\.Ticks\) > timeSyncThresholdTicks\)[\s\S]*?elapsedTime = TimeSpan\.Zero;[\s\S]*?if \(!request\.IsPlaying\)/u);
assert.match(sourceTexts.waiting, /var delayTicks = context\.PositionTicks - clientPosition\.Ticks;/u);
assert.match(sourceTexts.waiting, /Math\.Abs\(delayTicks\) > maxOffsetTicks/u);
assert.match(sourceTexts.controller, /\[HttpPost\("Ready"\)\][\s\S]*?new ReadyGroupRequest\(/u);
assert.match(sourceTexts.group, /public long TimeSyncOffset \{ get; \} = 2000;/u);
assert.match(sourceTexts.group, /public long MaxPlaybackOffset \{ get; \} = 500;/u);

await prepareReference(selectedPort);
assert.equal(await sha256File(recordedRecorderPath), await sha256File(recorderPath));
assert.equal(await sha256File(recordedScenarioPath), await sha256File(scenarioPath));

const stages = {};
const actualWhens = [];
let authToken;
let recording;
let contract;
let instance;
let readiness;
let processResult;
let shutdownRecord;
let persistenceMatches = [];
let outcomeError;
try {
  instance = startReference(selectedPort);
  readiness = await waitForReady(instance, origin);
  recording = await recordSyncPlayDateImpact(origin, {
    async onAuthenticated(context) {
      authToken = context.token;
      assert.equal(idKey(context.userId), '5c6b5f77bea94a9a98aafae5909892b7');
      stages.afterAuthentication = await databaseSnapshot();
    },
    async onBeforeTargetReady(definition) {
      actualWhens.push(definition.actualWhen);
      return { stdoutOffset: (await stat(stdoutPath)).size };
    },
    async onAfterTargetReady(definition, context) {
      const bytes = await readFile(stdoutPath);
      const excerpt = bytes.subarray(context.stdoutOffset).toString('utf8');
      const guardWarningCount = excerpt.split('is not time syncing properly. Ignoring elapsed time.').length - 1;
      const delayMatches = [...excerpt.matchAll(/\(delay of (-?\d+(?:\.\d+)?) seconds\)/gu)];
      assert.equal(delayMatches.length, 1, `${definition.name}: expected one native delay diagnostic`);
      return { guardWarningCount, delaySeconds: Number(delayMatches[0][1]), logExcerpt: excerpt };
    },
    async onCompleted() {
      stages.afterCases = await databaseSnapshot();
      persistenceMatches = await scanLogicalDatabase(actualWhens);
    },
  });
  contract = normalizeSyncPlayDateImpact(recording);
  for (const entry of recording.cases) {
    const expectsGuard = entry.boundary !== 'server-clock-minus-1000ms';
    assert.equal(entry.diagnostic.guardWarningCount, expectsGuard ? 1 : 0, `${entry.name}: native guard warning`);
    if (expectsGuard) assert.equal(entry.diagnostic.delaySeconds, 0, `${entry.name}: native post-guard delay`);
    else assert.ok(entry.diagnostic.delaySeconds < -0.5 && entry.diagnostic.delaySeconds > -2,
      `${entry.name}: inside-guard native delay must remain a bounded negative value`);
    assert.equal(outboundEchoes(entry), false, `${entry.name}: request When must not be echoed`);
  }
  assert.deepEqual(persistenceMatches, [], 'Ready request When values must not appear in the logical native database.');
  assert.equal(stable(stages.afterAuthentication.tables), stable(stages.afterCases.tables),
    'SyncPlay group/Ready traffic must not alter the logical native database.');
} catch (error) {
  outcomeError = error;
} finally {
  if (instance) {
    if (authToken && instance.child.exitCode === null && instance.child.signalCode === null) {
      try {
        shutdownRecord = await authenticatedRequest(origin, '/System/Shutdown', authToken, 'POST');
        if (shutdownRecord.status !== 204) throw new Error(`Native shutdown returned ${shutdownRecord.status}: ${shutdownRecord.bodyText}`);
      } catch (error) { outcomeError ??= error; }
    }
    processResult = await forceProcessTreeExit(instance);
    instance.closeDescriptors();
  }
  try { stages.afterShutdown = await databaseSnapshot(); }
  catch (error) { outcomeError ??= error; }
}

function outboundEchoes(entry) {
  return JSON.stringify({ response: entry.targetReady.body, messages: entry.targetReady.messages, group: entry.group.body })
    .includes(entry.actualWhen);
}

const sourceSummary = {
  baselineHead: baselineManifest.head,
  baselineContentDigest: baselineManifest.contentDigest,
  baselineManifestSha256: sha256Bytes(baselineManifestBytes),
  jellyfinDllSha256: await sha256File(jellyfinDll),
  dotnetSha256: await sha256File(dotnet),
  waitingGroupStateSha256: await sha256File(waitingStatePath),
  groupSha256: await sha256File(nativeGroupPath),
  syncPlayControllerSha256: await sha256File(controllerPath),
  candidateGroupSha256: await sha256File(candidateGroupPath),
  candidateDateSourceSha256: await sha256File(candidateDatePath),
  sourceDatabaseSha256: preparation.sourceDatabaseSha256,
};
const recorderSha256 = await sha256File(recordedRecorderPath);
const scenarioSha256 = await sha256File(recordedScenarioPath);
const portReleased = await portAvailable(selectedPort);
const pidGone = instance ? !processExists(instance.child.pid) : false;
const guardDiagnostics = recording?.cases.map(entry => ({
  name: entry.name,
  boundary: entry.boundary,
  isPlaying: entry.isPlaying,
  guardWarningCount: entry.diagnostic.guardWarningCount,
  delaySeconds: entry.diagnostic.delaySeconds,
  requestWhenEchoed: outboundEchoes(entry),
})) ?? [];
const expectedCommands = ['Unpause', 'Unpause', 'Unpause', 'Unpause', 'Seek', 'Unpause'];
const behaviorPassed = contract?.cases.length === syncPlayDateImpactCases.length
  && contract.cases.every((entry, index) => entry.result.command === expectedCommands[index]
    && entry.result.positionTicks === '6000000000'
    && entry.result.requestWhenEchoed === false
    && entry.result.state === (index === 4 ? 'Waiting' : 'Playing'));
const databaseStable = stages.afterAuthentication && stages.afterCases
  && stable(stages.afterAuthentication.tables) === stable(stages.afterCases.tables);
const foreignKeysPassed = Object.values(stages).every(stage => stage.foreignKeyCheck.length === 0);
const summary = {
  schemaVersion: 1,
  passed: !outcomeError && behaviorPassed && databaseStable && persistenceMatches.length === 0
    && foreignKeysPassed && readiness?.startupComplete && readiness.consecutiveHttpSuccesses >= 3
    && processResult?.code === 0 && processResult?.signal == null && pidGone && portReleased,
  cases: contract?.cases.length ?? 0,
  behaviorPassed,
  databaseStable,
  persistenceMatches,
  foreignKeysPassed,
  readiness,
  startupCompleteObserved: (await readFile(stdoutPath, 'utf8')).includes('Main: Startup complete'),
  processResult,
  pidGone,
  selectedPort,
  portReleased,
  shutdownRecord,
  recorderSha256,
  scenarioSha256,
  sourceSummary,
  guardDiagnostics,
  error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
};

await writeFile(path.join(nativeRun, 'native-http.json'), json(recording ?? { schemaVersion: 1, cases: [], raw: [] }), { flag: 'wx' });
await writeFile(path.join(nativeRun, 'native-contract.json'), json(contract ?? { schemaVersion: 1, cases: [] }), { flag: 'wx' });
await writeFile(path.join(nativeRun, 'database-stages.json'), json({ schemaVersion: 1, ...stages }), { flag: 'wx' });
await writeFile(path.join(nativeRun, 'summary.json'), json(summary), { flag: 'wx' });

const artifactNames = ['record-native.mjs', 'scenario.js', 'native-run/native-http.json', 'native-run/native-contract.json',
  'native-run/database-stages.json', 'native-run/summary.json', 'native-run/reference-stdout.log', 'native-run/reference-stderr.log'];
const artifacts = [];
for (const name of artifactNames) {
  const filename = path.join(evidenceRoot, name);
  const information = await stat(filename);
  artifacts.push({ path: name, size: information.size, sha256: await sha256File(filename) });
}
await writeFile(path.join(nativeRun, 'provenance.json'), json({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  sourceBoundary: 'Frozen Jellyfin HTTP POST /SyncPlay/Ready plus authenticated WebSocket output; native warning logs establish the two-second guard branch. Candidate output is not an input.',
  sourceSummary,
  referencePreparation: {
    initializedFromEmpty: preparation.initializedFromEmpty,
    createdThroughNativeApi: preparation.createdThroughNativeApi,
    sourceStopped: preparation.stopped,
    inputs: preparation.inputs,
  },
  recorder: { path: 'record-native.mjs', sha256: recorderSha256 },
  scenario: { path: 'scenario.js', sha256: scenarioSha256 },
  artifacts,
  limitations: [
    'The native guard decision is observed through Jellyfin warning logs and downstream WebSocket commands; Jellyfin does not expose its local delayTicks variable over HTTP.',
    'Dynamic guard controls use the native /GetUtcTime response and bounded 1000 ms / 3000 ms offsets; raw timestamps and messages remain in native-http.json.',
  ],
}), { flag: 'wx' });

if (!summary.passed) throw new Error(`Native SyncPlay date-impact recording failed: ${JSON.stringify(summary.error ?? summary)}`);
console.log(JSON.stringify({
  evidenceRoot: path.relative(repoRoot, evidenceRoot).replaceAll('\\', '/'),
  cases: summary.cases,
  selectedPort,
  databaseStable,
  processResult,
  pidGone,
  portReleased,
  recorderSha256,
  scenarioSha256,
}));
