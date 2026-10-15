// Record native Artist/Studio lookup side effects, Unicode SortNames and path races.
// Responses and persistence snapshots are observed from Jellyfin; candidate
// expectations are deliberately not an input to this recorder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { assertValidationOutputChild, validationExecutable, validationOutputRoot,
  validationPath } from '../validation/paths.js';
import { captureFilterReferencePreparation } from './filter-reference-inputs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modes = {
  concurrency: { runName: 'native-run', recorderName: 'record-native.mjs', parallel: 8 },
  unicode: { runName: 'native-run', recorderName: 'record-native.mjs' },
  race: { recorderName: 'record-path-race-native.mjs', parallel: 2, reverse: false },
  'race-reverse': { recorderName: 'record-path-race-reverse-native.mjs', parallel: 2, reverse: true },
  'race-eight': { recorderName: 'record-path-race-eight-native.mjs', parallel: 8, reverse: false },
  'race-eight-reverse': { recorderName: 'record-path-race-eight-reverse-native.mjs', parallel: 8, reverse: true },
};
const [kind, modeName, outputArgument, runArgument, portArgument] = process.argv.slice(2);
const mode = modes[modeName];
if (!['artist', 'studio'].includes(kind) || !mode || !outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-identity-side-effects.js <artist|studio> <concurrency|unicode|race|race-reverse|race-eight|race-eight-reverse> <evidence-root> <run-name-or-dash> <loopback-port>');
}
const evidenceName = modeName === 'unicode' ? `${kind}-unicode-sortname-native-v1`
  : kind === 'studio' && modeName.startsWith('race') ? 'studio-path-race-native-v1'
    : `${kind}-concurrency-native-v1`;
const recorderName = kind === 'studio' && modeName.startsWith('race')
  ? ({
    race: 'record-native.mjs',
    'race-reverse': 'record-reverse-native.mjs',
    'race-eight': 'record-eight-native.mjs',
    'race-eight-reverse': 'record-eight-reverse-native.mjs',
  })[modeName]
  : mode.recorderName;
const allowedRoot = validationOutputRoot();
const outputRoot = assertValidationOutputChild(path.resolve(repoRoot, outputArgument));
assert.equal(path.basename(outputRoot), evidenceName, `Evidence root must be named ${evidenceName}.`);
const runName = mode.runName ?? runArgument;
if (!/^native-run(?:-[a-z])?$/u.test(runName)) throw new Error('Invalid native run name.');
const runRoot = path.join(outputRoot, runName);
if (existsSync(runRoot)) throw new Error(`Native run already exists: ${runRoot}`);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');

const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const jellyfinDll = validationPath(path.join(repoRoot,
  '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const dotnetPath = validationExecutable('dotnet');
const ffmpegPath = validationExecutable('ffmpeg');
const referenceRoot = path.join(runRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const metadataPath = path.join(referenceRoot, 'data/metadata');
const metadataDirectoryName = kind === 'artist' ? 'artists' : 'Studio';
const metadataRoot = path.join(metadataPath, metadataDirectoryName);
const queryName = kind === 'artist' ? 'Artists' : 'Studios';
const listType = kind === 'artist' ? 'MusicArtist' : 'Studio';
const databaseEntityType = kind === 'artist'
  ? 'MediaBrowser.Controller.Entities.Audio.MusicArtist'
  : 'MediaBrowser.Controller.Entities.Studio';
const entityField = kind;
const movieId = '22222222-2222-2222-2222-222222222222';
const fixtureUserId = '5c6b5f77-bea9-4a9a-98aa-fae5909892b7';
const password = 'isolated-core-flow-password';
const origin = `http://127.0.0.1:${port}`;
const recorderPath = fileURLToPath(import.meta.url);
const recorderBytes = await readFile(recorderPath);
const recorderSource = recorderBytes.toString('utf8');
const candidateIdentityModuleMarker = ['src', 'library', 'identity.js'].join('/');
const candidateIdentitySymbols = [`native${'Artist'}Identity`, `native${'Studio'}Identity`];
const candidateIdentityImportAbsent = !recorderSource.includes(candidateIdentityModuleMarker)
  && candidateIdentitySymbols.every(symbol => !recorderSource.includes(symbol));
assert.equal(candidateIdentityImportAbsent, true, 'Recorder must not import candidate identity algorithms.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

async function portAvailable() {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
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

async function identityTree() {
  if (!existsSync(metadataRoot)) return [];
  const entries = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      entries.push({ name, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory()) await visit(target, name);
    }
  }
  await visit(metadataRoot);
  return entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function databaseRawSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA busy_timeout=5000');
  try {
    return {
      baseItemsCount: database.prepare('SELECT COUNT(*) AS count FROM "BaseItems"').get().count,
      rows: database.prepare('SELECT * FROM "BaseItems" ORDER BY "Id"').all().map(row => ({ ...row })),
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row })),
    };
  } finally {
    database.close();
  }
}

async function rawStage() {
  return {
    database: databaseRawSnapshot(),
    [`${kind}Tree`]: await identityTree(),
  };
}

function materializeStage(raw, watched) {
  if (!raw) return undefined;
  return {
    database: {
      baseItemsCount: raw.database.baseItemsCount,
      watchedRows: watched.map(item => ({ ...item,
        row: raw.database.rows.find(row => idKey(row.Id) === idKey(item.id)) ?? null })),
      foreignKeyCheck: raw.database.foreignKeyCheck,
    },
    [`${kind}Tree`]: raw[`${kind}Tree`],
  };
}

function discoverNativeIdentity(rawStages, watchedNames) {
  const discoveryStage = modeName === 'unicode' ? rawStages.afterCreate2 : rawStages.afterBatch;
  assert.ok(discoveryStage, 'Native identity discovery stage is missing.');
  const beforeIds = new Set(rawStages.before.database.rows.map(row => idKey(row.Id)));
  const addedRows = discoveryStage.database.rows.filter(row => !beforeIds.has(idKey(row.Id)));
  const expectedRows = modeName === 'unicode' ? 2 : 1;
  assert.equal(addedRows.length, expectedRows, 'Unexpected native BaseItems identity delta.');
  assert.ok(addedRows.every(row => row.Type === databaseEntityType), 'Native delta contained a different entity type.');

  const allowedNames = new Set(watchedNames);
  assert.ok(addedRows.every(row => allowedNames.has(row.Name)), 'Native delta contained an unexpected entity name.');
  if (modeName === 'unicode') {
    assert.deepEqual(new Set(addedRows.map(row => row.Name)), allowedNames,
      'Native Unicode delta did not contain both requested names.');
  } else if (modeName === 'concurrency') {
    assert.equal(addedRows[0].Name, watchedNames[0], 'Native concurrent delta used an unexpected name.');
  }

  const pathPrefix = `%MetadataPath%\\${metadataDirectoryName}\\`;
  const treeDirectories = new Set(discoveryStage[`${kind}Tree`]
    .filter(entry => entry.type === 'directory').map(entry => entry.name));
  for (const row of addedRows) {
    assert.equal(row.ParentId, null, 'Native identity row unexpectedly has a parent.');
    assert.ok(row.Path?.startsWith(pathPrefix), 'Native identity row path is outside its metadata root.');
    assert.ok(treeDirectories.has(path.win32.basename(row.Path)),
      'Native identity row path is not represented by the observed metadata tree.');
  }

  const existingBeforeIds = new Set(rawStages.before.database.rows.map(row => idKey(row.Id)));
  const deliberatelyWrongPredictedId = Array.from({ length: 4096 }, (_value, index) =>
    `DEAD0000-0000-0000-0000-${index.toString(16).padStart(12, '0').toUpperCase()}`)
    .find(candidate => !existingBeforeIds.has(idKey(candidate)));
  assert.ok(deliberatelyWrongPredictedId, 'Could not allocate an absent negative-control ID.');
  const wrongIdBeforeMatches = rawStages.before.database.rows
    .filter(row => idKey(row.Id) === idKey(deliberatelyWrongPredictedId)).length;
  const wrongIdAfterMatches = discoveryStage.database.rows
    .filter(row => idKey(row.Id) === idKey(deliberatelyWrongPredictedId)).length;
  assert.equal(wrongIdBeforeMatches, 0, 'Negative-control ID unexpectedly existed before the native request.');
  assert.equal(wrongIdAfterMatches, 0, 'Negative-control ID unexpectedly matched a native row.');
  assert.ok(addedRows.every(row => idKey(row.Id) !== idKey(deliberatelyWrongPredictedId)),
    'Negative-control ID influenced native delta selection.');

  const byName = new Map(addedRows.map(row => [row.Name, row]));
  const watched = modeName === 'unicode'
    ? watchedNames.map(name => ({ name, id: byName.get(name).Id }))
    : modeName === 'concurrency'
      ? [{ name: watchedNames[0], id: addedRows[0].Id }]
      : watchedNames.map(name => ({ name, id: addedRows[0].Id }));
  return {
    watched,
    evidence: {
      method: 'native-sqlite-baseitems-before-after-id-delta-v1',
      selectionInputs: ['BaseItems.Id delta', 'BaseItems.Type', 'BaseItems.Name', 'BaseItems.Path', 'metadata tree'],
      databaseEntityType,
      requestedNames: watchedNames,
      discoveredRows: addedRows.map(row => ({ id: row.Id, name: row.Name, type: row.Type, path: row.Path })),
      negativeControl: {
        deliberatelyWrongPredictedId,
        beforeMatches: wrongIdBeforeMatches,
        afterMatches: wrongIdAfterMatches,
        selectedMatches: 0,
      },
      candidateIdentityImportAbsent,
    },
  };
}

async function prepareReference() {
  const preparation = await captureFilterReferencePreparation({
    sourceRoot,
    sourceDatabase,
    repoRoot,
    fixtureUserId,
  });
  await mkdir(outputRoot, { recursive: true });
  const recorderTarget = path.join(outputRoot, recorderName);
  if (existsSync(recorderTarget)) {
    assert.ok((await readFile(recorderTarget)).equals(recorderBytes), `${recorderName} does not match this recorder.`);
  } else {
    await writeFile(recorderTarget, recorderBytes, { flag: 'wx' });
  }
  await mkdir(runRoot);
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    },
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const source of sourceForms) content = content.replaceAll(source, referenceRoot);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu,
        (_match, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }
  await writeFile(path.join(runRoot, 'reference-preparation.json'), json(preparation), { flag: 'wx' });
  return preparation;
}

function authorization(token) {
  return `MediaBrowser Client="IdentitySideEffectOracle", Device="Isolated", DeviceId="identity-side-effect-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
}

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authorization(token),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); }
  catch { bodyJson = undefined; }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson }),
  };
}

function startReference() {
  const stdoutPath = path.join(runRoot, 'reference-stdout.log');
  const stdoutDescriptor = openSync(stdoutPath, 'wx');
  const stderrDescriptor = openSync(path.join(runRoot, 'reference-stderr.log'), 'wx');
  const args = [jellyfinDll,
    '--datadir', path.join(referenceRoot, 'data'), '--configdir', path.join(referenceRoot, 'config'),
    '--cachedir', path.join(referenceRoot, 'cache'), '--logdir', path.join(referenceRoot, 'log'),
    '--ffmpeg', ffmpegPath, '--nowebclient'];
  const child = spawn(dotnetPath, args, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
  });
  let spawnError;
  const completion = new Promise(resolve => {
    child.once('error', error => {
      spawnError = error;
      resolve({ code: null, signal: null, error: { name: error.name, message: error.message } });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, command: [dotnetPath, ...args], get spawnError() { return spawnError; }, stdoutPath,
    stdoutDescriptor, stderrDescriptor };
}

async function waitForReady(instance) {
  let consecutiveSuccesses = 0;
  let startupComplete = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance.spawnError) throw instance.spawnError;
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode}/${instance.child.signalCode}.`);
    }
    try {
      startupComplete ||= (await readFile(instance.stdoutPath, 'utf8')).includes('Main: Startup complete');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1_000) });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      await response.body?.cancel();
      if (startupComplete && consecutiveSuccesses >= 3) {
        return { startupComplete: true, httpReady: true, consecutiveHttpSuccesses: consecutiveSuccesses,
          attempts: attempt + 1 };
      }
    } catch {
      consecutiveSuccesses = 0;
    }
    await delay(500);
  }
  throw new Error(`Frozen reference did not become ready within 60 seconds (startupComplete=${startupComplete}, consecutiveHttpSuccesses=${consecutiveSuccesses}).`);
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function confirmStopped(instance) {
  let pidGone = false;
  let released = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    pidGone = processIsGone(instance.child.pid);
    released = await portAvailable();
    if (pidGone && released) return { pidGone, portAvailable: released, attempts: attempt + 1 };
    await delay(250);
  }
  return { pidGone, portAvailable: released, attempts: 40 };
}

async function stopReference(instance, token) {
  let shutdownStatus = null;
  let result;
  if (instance.child.exitCode === null && token) {
    try { shutdownStatus = (await request('/System/Shutdown', { method: 'POST', token })).status; }
    catch { shutdownStatus = null; }
  }
  if (instance.child.exitCode === null) {
    result = await Promise.race([instance.completion, delay(20_000).then(() => null)]);
    if (result === null) {
      instance.child.kill();
      result = await Promise.race([instance.completion, delay(10_000).then(() => null)]);
    }
    if (result === null && instance.child.pid) {
      spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
        cwd: repoRoot, windowsHide: true, encoding: 'utf8', timeout: 10_000,
      });
      result = await Promise.race([instance.completion, delay(10_000).then(() => null)]);
    }
  } else {
    result = await instance.completion;
  }
  for (const descriptor of [instance.stdoutDescriptor, instance.stderrDescriptor]) {
    try { closeSync(descriptor); } catch { /* Already released. */ }
  }
  const stopped = await confirmStopped(instance);
  return {
    result: result ?? { code: null, signal: null },
    shutdownStatus,
    ...stopped,
  };
}

function sideEffectRoute(name) {
  return `/Items?Ids=${movieId}&${queryName}=${encodeURIComponent(name)}&Fields=SortName&EnableImages=false&EnableUserData=false`;
}

function recordFor(name, requestName, route, response) {
  return { name: requestName, [entityField]: name, route, response };
}

function raceNames() {
  const names = ['Mirror/A', 'Mirror:A'];
  const ordered = mode.reverse ? [...names].reverse() : names;
  return Array.from({ length: mode.parallel }, (_value, index) => ordered[index % ordered.length]);
}

async function updateOracleValidation(runSummary) {
  const filename = path.join(outputRoot, 'oracle-validation.json');
  const expectedRunModes = evidenceName === 'artist-concurrency-native-v1'
    ? { 'native-run': 'concurrency', 'native-run-b': 'race', 'native-run-c': 'race',
      'native-run-d': 'race-reverse', 'native-run-f': 'race-eight', 'native-run-g': 'race-eight-reverse' }
    : evidenceName === 'studio-path-race-native-v1'
      ? { 'native-run-b': 'race', 'native-run-c': 'race', 'native-run-d': 'race-reverse',
        'native-run-f': 'race-eight', 'native-run-g': 'race-eight-reverse' }
      : { 'native-run': modeName };
  let document = { schemaVersion: 2, candidateVerified: false, kind, evidenceName,
    expectedRunModes, runs: {} };
  if (existsSync(filename)) {
    document = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(document.schemaVersion, 2, 'Aggregate schema version changed during recording.');
    assert.equal(document.kind, kind, 'Aggregate kind changed during recording.');
    assert.equal(document.evidenceName, evidenceName, 'Aggregate evidence root changed during recording.');
    assert.deepEqual(document.expectedRunModes, expectedRunModes,
      'Aggregate expected run matrix changed during recording.');
  }
  document.runs[runName] = runSummary;
  const expectedRuns = Object.keys(expectedRunModes);
  const actualRuns = Object.keys(document.runs);
  document.complete = expectedRuns.every(name => document.runs[name])
    && actualRuns.every(name => expectedRunModes[name]);
  document.runBindingsValid = actualRuns.every(name => {
    const item = document.runs[name];
    return item.kind === kind && item.evidenceName === evidenceName && item.runName === name
      && item.mode === expectedRunModes[name] && item.invocation?.kind === kind
      && item.invocation?.mode === expectedRunModes[name] && item.invocation?.runName === name
      && ['nativeHttpSha256', 'stagesSha256', 'summarySha256', 'referencePreparationSha256']
        .every(field => /^[a-f0-9]{64}$/u.test(item.artifacts?.[field]))
      && Array.isArray(item.artifactManifest) && item.artifactManifest.length === 5
      && item.artifactManifest.every(entry => Number.isSafeInteger(entry.size) && entry.size >= 0
        && /^[a-f0-9]{64}$/u.test(entry.sha256));
  });
  const raceRuns = expectedRuns.filter(name => expectedRunModes[name].startsWith('race'));
  const winners = [...new Set(raceRuns.map(name => document.runs[name]?.winner).filter(Boolean))].sort();
  const winnerCoveragePassed = raceRuns.length === 0
    || (winners.length === 2 && winners.includes('Mirror/A') && winners.includes('Mirror:A'));
  document.winnerCoverage = { required: raceRuns.length > 0, winners, passed: winnerCoveragePassed };
  document.passed = document.complete && document.runBindingsValid && winnerCoveragePassed
    && expectedRuns.every(name => document.runs[name]?.passed === true);
  await writeFile(filename, json(document));
}

assert.equal(await portAvailable(), true, 'Loopback port is occupied.');
const sourceDatabaseSha256 = sha256(await readFile(sourceDatabase));
const inputHashes = {
  recorderSha256: sha256(recorderBytes),
  sourceDatabaseSha256,
  dllSha256: sha256(await readFile(jellyfinDll)),
  dotnetSha256: sha256(await readFile(dotnetPath)),
  ffmpegSha256: sha256(await readFile(ffmpegPath)),
};
let preparation;
try {
  preparation = await prepareReference();
} catch (error) {
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, 'preparation-failure.json'), json({
    passed: false,
    candidateVerified: false,
    ...inputHashes,
    error: { name: error.name, message: error.message, stack: error.stack },
  }), { flag: 'wx' });
  throw error;
}

const watchedNames = modeName === 'unicode' ? ['東京', 'ｶﾞ']
  : modeName === 'concurrency' ? ['Concurrent Alpha'] : ['Mirror/A', 'Mirror:A'];
const rawStages = { before: await rawStage() };
const stages = {};
const records = [];
let watched = watchedNames.map(name => ({ name, id: null }));
let identityDiscovery;
let instance;
let token;
let outcomeError;
let readiness = { startupComplete: false, httpReady: false, consecutiveHttpSuccesses: 0, attempts: 0 };
let lifecycle = { result: { code: null, signal: null }, shutdownStatus: null,
  pidGone: false, portAvailable: false, attempts: 0 };
try {
  instance = startReference();
  readiness = await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', {
    method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password },
  });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  token = login.bodyJson.AccessToken;
  assert.equal(idKey(login.bodyJson.User.Id), idKey(fixtureUserId));

  if (modeName === 'concurrency') {
    const name = watchedNames[0];
    const route = sideEffectRoute(name);
    const batch = await Promise.all(Array.from({ length: mode.parallel }, async (_value, index) =>
      recordFor(name, `parallel-${index + 1}`, route, await request(route, { token }))));
    records.push(...batch);
    rawStages.afterBatch = await rawStage();
    records.push(recordFor(name, 'followup', route, await request(route, { token })));
    rawStages.afterFollowup = await rawStage();
  } else if (modeName === 'unicode') {
    for (const [index, name] of watchedNames.entries()) {
      const route = sideEffectRoute(name);
      records.push(recordFor(name, `create-${index + 1}`, route, await request(route, { token })));
      rawStages[`afterCreate${index + 1}`] = await rawStage();
    }
    const listRoute = `/Items?Fields=SortName&EnableImages=false&EnableUserData=false&IncludeItemTypes=${listType}`;
    records.push({ name: 'list', route: listRoute, response: await request(listRoute, { token }) });
    rawStages.afterList = await rawStage();
    const followupRoute = sideEffectRoute(watchedNames[0]);
    records.push(recordFor(watchedNames[0], 'followup', followupRoute, await request(followupRoute, { token })));
    rawStages.afterFollowup = await rawStage();
  } else {
    const parallelNames = raceNames();
    const batch = await Promise.all(parallelNames.map(async (name, index) => {
      const route = sideEffectRoute(name);
      return recordFor(name, `parallel-${index + 1}`, route, await request(route, { token }));
    }));
    records.push(...batch);
    rawStages.afterBatch = await rawStage();
    for (const [index, name] of watchedNames.entries()) {
      const route = sideEffectRoute(name);
      records.push(recordFor(name, `followup-${index + 1}`, route, await request(route, { token })));
    }
    rawStages.afterFollowup = await rawStage();
  }
} catch (error) {
  outcomeError = error;
} finally {
  if (instance) lifecycle = await stopReference(instance, token);
  try { rawStages.afterShutdown = await rawStage(); }
  catch (error) { outcomeError ??= error; }

  try {
    ({ watched, evidence: identityDiscovery } = discoverNativeIdentity(rawStages, watchedNames));
  } catch (error) {
    outcomeError ??= error;
  }
  for (const [name, value] of Object.entries(rawStages)) stages[name] = materializeStage(value, watched);

  const nativeHttpPath = path.join(runRoot, 'native-http.json');
  const stagesPath = path.join(runRoot, 'stages.json');
  const summaryPath = path.join(runRoot, 'summary.json');
  const preparationPath = path.join(runRoot, 'reference-preparation.json');
  await writeFile(nativeHttpPath, json({ origin, records }), { flag: 'wx' });
  await writeFile(stagesPath, json({ schemaVersion: 2, kind, mode: modeName, watched,
    identityDiscovery, ...stages }), { flag: 'wx' });
  const expectedCases = modeName === 'concurrency' ? 9 : modeName === 'unicode' ? 4 : mode.parallel + 2;
  const stageValues = Object.values(stages);
  const foreignKeysValid = stageValues.length > 0
    && stageValues.every(value => value.database.foreignKeyCheck.length === 0);
  const rowsAfter = modeName === 'unicode' ? stages.afterCreate2 : stages.afterBatch;
  const rowDeltaValid = rowsAfter?.database.baseItemsCount - stages.before.database.baseItemsCount
    === (modeName === 'unicode' ? 2 : 1);
  const watchedRowsValid = rowsAfter?.database.watchedRows.every(item => item.row !== null);
  const identityDiscoveryValid = identityDiscovery?.candidateIdentityImportAbsent === true
    && identityDiscovery?.negativeControl?.beforeMatches === 0
    && identityDiscovery?.negativeControl?.afterMatches === 0
    && identityDiscovery?.negativeControl?.selectedMatches === 0;
  const readinessValid = readiness.startupComplete === true && readiness.httpReady === true
    && readiness.consecutiveHttpSuccesses >= 3;
  const finalStateStable = Boolean(stages.afterFollowup && stages.afterShutdown)
    && JSON.stringify(stages.afterFollowup.database) === JSON.stringify(stages.afterShutdown.database)
    && JSON.stringify(stages.afterFollowup[`${kind}Tree`]) === JSON.stringify(stages.afterShutdown[`${kind}Tree`]);
  const responsesValid = records.length === expectedCases && records.every(record => record.response.status === 200
    && record.response.contentType?.startsWith('application/json') && record.response.bodyJson);
  const sourceUnchanged = sha256(await readFile(sourceDatabase)) === sourceDatabaseSha256;
  const runtimeInputsAfter = {
    dotnetSha256: sha256(await readFile(dotnetPath)),
    dllSha256: sha256(await readFile(jellyfinDll)),
    ffmpegSha256: sha256(await readFile(ffmpegPath)),
  };
  const runtimeInputsUnchanged = runtimeInputsAfter.dotnetSha256 === inputHashes.dotnetSha256
    && runtimeInputsAfter.dllSha256 === inputHashes.dllSha256
    && runtimeInputsAfter.ffmpegSha256 === inputHashes.ffmpegSha256;
  const preparedExecutables = preparation?.inputs?.filter(input => input.kind === 'nativeReferencePreparationExecutable');
  const launchBound = instance?.command?.[0] === dotnetPath && instance?.command?.[1] === jellyfinDll
    && instance?.command?.[instance.command.indexOf('--ffmpeg') + 1] === ffmpegPath
    && preparedExecutables?.[0]?.sha256 === inputHashes.dotnetSha256
    && preparedExecutables?.[1]?.sha256 === inputHashes.dllSha256
    && preparedExecutables?.[2]?.sha256 === inputHashes.ffmpegSha256;
  const passed = !outcomeError && preparation?.initializedFromEmpty === true
    && foreignKeysValid && rowDeltaValid && watchedRowsValid && identityDiscoveryValid && readinessValid
    && finalStateStable && responsesValid && sourceUnchanged && runtimeInputsUnchanged && launchBound
    && lifecycle.shutdownStatus === 204 && lifecycle.result?.code === 0 && lifecycle.result?.signal === null
    && lifecycle.pidGone && lifecycle.portAvailable;
  const invocation = { kind, mode: modeName, runName, evidenceName, recorderName,
    outputRoot: path.relative(allowedRoot, outputRoot).replaceAll('\\', '/'), loopbackPort: port };
  const summary = {
    passed,
    candidateVerified: false,
    kind,
    mode: modeName,
    runName,
    evidenceName,
    invocation,
    cases: records.length,
    readiness,
    identityDiscovery,
    processResult: { code: lifecycle.result?.code ?? null, signal: lifecycle.result?.signal ?? null },
    portAvailable: lifecycle.portAvailable,
    pidGone: lifecycle.pidGone,
    shutdownConfirmationAttempts: lifecycle.attempts,
    cleanShutdown: lifecycle.shutdownStatus === 204,
    ...inputHashes,
    launch: { command: instance?.command ?? null, before: {
      dotnetSha256: inputHashes.dotnetSha256, dllSha256: inputHashes.dllSha256,
      ffmpegSha256: inputHashes.ffmpegSha256,
    }, after: runtimeInputsAfter },
    checks: { preparedNativeInstance: preparation?.initializedFromEmpty === true, foreignKeysValid,
      rowDeltaValid, watchedRowsValid, candidateIndependentIdentityDiscovery: identityDiscoveryValid,
      nativeStartupCompleteAndHttpReady: readinessValid, finalStateStable, responsesValid, sourceUnchanged,
      runtimeInputsUnchanged, launchBound },
    error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
  };
  await writeFile(summaryPath, json(summary), { flag: 'wx' });
  const artifacts = {
    nativeHttpSha256: sha256(await readFile(nativeHttpPath)),
    stagesSha256: sha256(await readFile(stagesPath)),
    summarySha256: sha256(await readFile(summaryPath)),
    referencePreparationSha256: sha256(await readFile(preparationPath)),
  };
  const artifactNames = [recorderName, `${runName}/reference-preparation.json`, `${runName}/native-http.json`,
    `${runName}/stages.json`, `${runName}/summary.json`];
  const artifactManifest = [];
  for (const relative of artifactNames) {
    const bytes = await readFile(path.join(outputRoot, relative));
    artifactManifest.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  const winner = rowsAfter?.database.watchedRows[0]?.row?.Name ?? null;
  await updateOracleValidation({ passed, kind, mode: modeName, runName, evidenceName, invocation,
    cases: records.length, winner, recorder: recorderName, recorderSha256: inputHashes.recorderSha256,
    sourceDatabaseSha256, dllSha256: inputHashes.dllSha256, dotnetSha256: inputHashes.dotnetSha256,
    ffmpegSha256: inputHashes.ffmpegSha256, launch: summary.launch, artifacts, artifactManifest,
    checks: summary.checks });
  if (!passed) throw new Error(`Native ${kind} ${modeName} recording failed: ${JSON.stringify(summary.error ?? summary.checks)}`);
  console.log(JSON.stringify({ evidence: path.relative(repoRoot, outputRoot).replaceAll('\\', '/'),
    run: runName, cases: records.length, processResult: summary.processResult,
    portAvailable: summary.portAvailable, winner }));
}
