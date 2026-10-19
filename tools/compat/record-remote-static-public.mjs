import { assertValidationOutputChild, validationExecutable, validationPath } from '../validation/paths.js';
// Isolated frozen-Jellyfin oracle for redirects involving publicly trusted HTTPS endpoints.
// The stopped reference instance and its initial database are copied; neither input is modified.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { closeSync, constants, existsSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceFilename = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(sourceFilename), '../..');
const [outputArgument, nativePortArgument] = process.argv.slice(2);
if (!outputArgument || !nativePortArgument) {
  throw new Error('Usage: node tools/compat/record-remote-static-public.mjs <new-evidence-directory> <native-port>');
}

const evidence = assertValidationOutputChild(path.resolve(repo, outputArgument));
if (existsSync(evidence)) {
  throw new Error('Evidence must be a new child directory of the configured validation output root.');
}
const nativeRun = path.join(evidence, 'native-run');
const nativePort = Number(nativePortArgument);
if (!Number.isInteger(nativePort) || nativePort < 1024 || nativePort > 65535) {
  throw new Error('A non-privileged loopback port is required.');
}

const sourceRoot = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const reference = path.join(nativeRun, 'reference');
const databasePath = path.join(reference, 'data/data/jellyfin.db');
const bundledSourceDatabase = path.join(evidence, 'source-initial.db');
const dotnet = validationExecutable('dotnet');
const dll = validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${nativePort}`;
const adminId = '5C6B5F77-BEA9-4A9A-98AA-FAE5909892B7';
const password = 'isolated-core-flow-password';
const licenseUrl = 'https://raw.githubusercontent.com/jellyfin/jellyfin/208c278b75/LICENSE';
const redirect = target => `https://httpbin.org/redirect-to?url=${encodeURIComponent(target)}`;
const licenseContent = {
  size: 18014,
  sha256: 'f371b80469fb235bc500ec29e0e85b682d4a6157a158567d828ff0be544d4f1d',
};
const cases = [
  { name: 'trusted-direct', id: '95000000-0000-0000-0000-000000000001', target: licenseUrl,
    expected: { status: 200, ...licenseContent,
      headers: { 'accept-ranges': 'bytes', 'content-type': 'text/plain; charset=utf-8' },
      absentHeaders: ['content-length', 'location'] } },
  { name: 'trusted-downgrade', id: '95000000-0000-0000-0000-000000000002',
    target: redirect(licenseUrl.replace('https:', 'http:')),
    expected: { status: 302, size: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { 'accept-ranges': 'none', 'content-length': '0', 'content-type': 'text/html; charset=utf-8' },
      absentHeaders: ['location'] } },
  { name: 'trusted-cross-https', id: '95000000-0000-0000-0000-000000000003', target: redirect(licenseUrl),
    expected: { status: 200, ...licenseContent,
      headers: { 'accept-ranges': 'bytes', 'content-type': 'text/plain; charset=utf-8' },
      absentHeaders: ['content-length', 'location'] } },
];
const responseHeaders = ['accept-ranges', 'content-length', 'content-range', 'content-type', 'location'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const stableDigestRecord = value => JSON.stringify(value);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const targetProvenance = {
  kind: 'public-https-targets-observed-through-frozen-jellyfin',
  license: {
    repository: 'jellyfin/jellyfin',
    commit: '208c278b75',
    path: 'LICENSE',
    url: licenseUrl,
    ...licenseContent,
  },
  redirectService: 'https://httpbin.org/redirect-to',
  observationScope: 'The recorder observes Jellyfin client responses only; it does not claim to instrument public upstream or TLS request hops.',
};

async function sourceInputDigests() {
  return {
    recorderSha256: sha256(await readFile(sourceFilename)),
    sourceDatabaseSha256: sha256(await readFile(sourceDatabase)),
    dllSha256: sha256(await readFile(dll)),
  };
}

async function available(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else files.push(item);
  }
  return files;
}

async function prepareReference(sourceInputsBefore) {
  await mkdir(nativeRun, { recursive: true });
  const recordedSourcePath = path.join(evidence, 'record-native.mjs');
  await copyFile(sourceFilename, recordedSourcePath, constants.COPYFILE_EXCL);
  const copiedRecorderSha256 = sha256(await readFile(recordedSourcePath));
  assert.equal(copiedRecorderSha256, sourceInputsBefore.recorderSha256,
    'The evidence recorder copy must bind to the source recorder bytes captured before preparation.');
  await copyFile(sourceDatabase, bundledSourceDatabase, constants.COPYFILE_EXCL);
  const bundledSourceDatabaseSha256 = sha256(await readFile(bundledSourceDatabase));
  assert.equal(bundledSourceDatabaseSha256, sourceInputsBefore.sourceDatabaseSha256,
    'The bundled source database must bind to the stopped source database bytes captured before preparation.');
  await cp(sourceRoot, reference, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    },
  });
  await mkdir(path.join(reference, 'log'), { recursive: true });
  await cp(bundledSourceDatabase, databasePath, { force: false, errorOnExist: true });
  const copiedDatabaseSha256 = sha256(await readFile(databasePath));
  assert.equal(copiedDatabaseSha256, sourceInputsBefore.sourceDatabaseSha256,
    'The working database must begin as an exact source-database copy.');
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(reference)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const oldPath of sourceForms) content = content.replaceAll(oldPath, reference);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu,
        (_, name) => `<${name}>${nativePort}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }

  const shortcutDirectory = path.join(reference, 'library-content');
  await mkdir(shortcutDirectory, { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    const template = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
      .get('22222222-2222-2222-2222-222222222222');
    assert.ok(template, 'The stopped reference database lacks the remote playback template.');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of cases) {
        const shortcutPath = path.join(shortcutDirectory, `${entry.name}.strm`);
        await writeFile(shortcutPath, `${entry.target}\n`);
        const row = {
          ...template,
          Id: entry.id.toUpperCase(),
          Name: `Remote Static ${entry.name}`,
          CleanName: `remote static ${entry.name}`,
          SortName: `remote static ${entry.name}`,
          Path: shortcutPath,
          PresentationUniqueKey: entry.id.replaceAll('-', '').toLowerCase(),
          Data: JSON.stringify({
            VideoType: 'VideoFile', IsHD: false, IsShortcut: true,
            ShortcutPath: entry.target, RemoteTrailers: [],
          }),
        };
        const columns = Object.keys(row);
        const quoted = column => `"${column.replaceAll('"', '""')}"`;
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quoted).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(column => row[column]));
        database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") SELECT ?, "ParentItemId" FROM "AncestorIds" WHERE "ItemId" = ?')
          .run(row.Id, template.Id);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
  return { recordedSourcePath, copiedRecorderSha256, bundledSourceDatabaseSha256, copiedDatabaseSha256 };
}

function startReference() {
  const stdout = openSync(path.join(nativeRun, 'reference-stdout.log'), 'wx');
  const stderr = openSync(path.join(nativeRun, 'reference-stderr.log'), 'wx');
  const args = [
    dll,
    '--datadir', path.join(reference, 'data'),
    '--configdir', path.join(reference, 'config'),
    '--cachedir', path.join(reference, 'cache'),
    '--logdir', path.join(reference, 'log'),
    '--nowebclient',
  ];
  const child = spawn(dotnet, args, { cwd: repo, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({
      code: null, signal: null, error: { name: error.name, message: error.message },
    }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    completion,
    command: [dotnet, ...args],
    closeDescriptors() { closeSync(stdout); closeSync(stderr); },
  };
}

async function waitForReady(instance) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode}/${instance.child.signalCode}`);
    }
    try {
      const startupLog = await readFile(path.join(nativeRun, 'reference-stdout.log'), 'utf8');
      const response = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(1000) });
      const ready = response.ok;
      await response.body?.cancel();
      if (startupLog.includes('Main: Startup complete') && ready) return;
    } catch { /* Wait for the frozen process to complete startup. */ }
    await delay(500);
  }
  throw new Error('Frozen reference did not become ready.');
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function waitForCondition(operation, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    if (await operation()) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return await operation();
}

async function waitForCompletion(instance, timeoutMilliseconds) {
  return Promise.race([instance.completion, delay(timeoutMilliseconds).then(() => null)]);
}

async function stopReference(instance, token) {
  let shutdownStatus = null;
  if (token && instance.child.exitCode === null && instance.child.signalCode === null) {
    try { shutdownStatus = (await request('/System/Shutdown', { method: 'POST', token })).status; }
    catch { shutdownStatus = null; }
  }
  let result = await waitForCompletion(instance, 20_000);
  if (result === null && !processIsGone(instance.child.pid)) {
    instance.child.kill();
    result = await waitForCompletion(instance, 10_000);
  }
  if (result === null && !processIsGone(instance.child.pid)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
        cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 10_000,
      });
    } else {
      instance.child.kill('SIGKILL');
    }
    result = await waitForCompletion(instance, 10_000);
  }
  const pidGone = await waitForCondition(() => processIsGone(instance.child.pid), 10_000);
  const portReleased = await waitForCondition(() => available(nativePort), 10_000);
  instance.closeDescriptors();
  return {
    shutdownStatus,
    result: result ?? { code: null, signal: null },
    pidGone,
    portReleased,
  };
}

const authorization = token => `MediaBrowser Client="RemoteStaticPublicOracle", Device="Isolated", DeviceId="remote-static-public-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
async function request(route, { method = 'GET', token, headers = {}, body } = {}) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      Authorization: authorization(token),
      ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'manual',
  });
  const chunks = [];
  let bodyReadError = null;
  try {
    for await (const chunk of response.body ?? []) chunks.push(Buffer.from(chunk));
  } catch (error) {
    bodyReadError = { name: error.name, message: error.message };
  }
  const bytes = Buffer.concat(chunks);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* Binary response. */ }
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
    size: bytes.length,
    sha256: sha256(bytes),
    bodyText: bytes.length <= 256 ? bytes.toString('utf8') : null,
    bodyReadError,
    ...(parsed === undefined ? {} : { bodyJson: parsed }),
  };
}

function remoteContract(records) {
  const failures = [];
  if (records.length !== cases.length) failures.push(`response count ${records.length}, expected ${cases.length}`);
  for (let index = 0; index < Math.max(records.length, cases.length); index++) {
    const record = records[index], expectedCase = cases[index];
    if (!record || !expectedCase) {
      failures.push(`record[${index}] is ${record ? 'unexpected' : 'missing'}`);
      continue;
    }
    const label = expectedCase.name;
    if (record.name !== expectedCase.name || record.itemId !== expectedCase.id
      || record.method !== 'GET' || record.target !== expectedCase.target) {
      failures.push(`${label}: case identity or target provenance mismatch`);
    }
    const response = record.response;
    if (response.bodyReadError !== null) failures.push(`${label}: response body read failed`);
    for (const field of ['status', 'size', 'sha256']) {
      if (response[field] !== expectedCase.expected[field]) {
        failures.push(`${label}: ${field} ${JSON.stringify(response[field])}, expected ${JSON.stringify(expectedCase.expected[field])}`);
      }
    }
    for (const [name, value] of Object.entries(expectedCase.expected.headers)) {
      if (response.headers?.[name] !== value) failures.push(`${label}: header ${name} did not match`);
    }
    for (const name of expectedCase.expected.absentHeaders) {
      if (Object.hasOwn(response.headers ?? {}, name)) failures.push(`${label}: header ${name} must be absent`);
    }
    if (expectedCase.expected.status === 302 && response.bodyText !== '') {
      failures.push(`${label}: downgrade response body must be empty`);
    }
  }
  return {
    passed: failures.length === 0,
    statusesValid: records.length === cases.length
      && records.every((record, index) => record.response.status === cases[index].expected.status),
    bodiesComplete: records.length === cases.length
      && records.every(record => record.response.bodyReadError === null),
    contentValid: failures.every(message => !/: (?:size|sha256) /u.test(message)),
    headersValid: failures.every(message => !/header/u.test(message)),
    provenanceValid: failures.every(message => !/provenance/u.test(message)),
    failures,
  };
}

const nativePortBefore = await available(nativePort);
assert.equal(nativePortBefore, true, 'Native loopback port is occupied.');

await mkdir(evidence);
const sourceInputsBefore = await sourceInputDigests();
const copyBindings = await prepareReference(sourceInputsBefore);
let instance;
let token;
let outcomeError;
let lifecycle = { shutdownStatus: null, result: { code: null, signal: null }, pidGone: false, portReleased: false };
let launchDllSha256 = null;
let launchCommandBound = false;
const records = [];
try {
  launchDllSha256 = sha256(await readFile(dll));
  assert.equal(launchDllSha256, sourceInputsBefore.dllSha256,
    'The Jellyfin DLL changed between input capture and process launch.');
  instance = startReference();
  launchCommandBound = path.resolve(instance.command[1]) === path.resolve(dll);
  assert.equal(launchCommandBound, true, 'The frozen process must launch the captured Jellyfin DLL.');
  await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', {
    method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password },
  });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  assert.equal(login.bodyJson.User.Id.replaceAll('-', '').toLowerCase(), adminId.replaceAll('-', '').toLowerCase());
  token = login.bodyJson.AccessToken;
  for (const entry of cases) {
    const route = `/Videos/${entry.id}/stream?static=true&mediaSourceId=${entry.id.replaceAll('-', '')}`;
    records.push({
      name: entry.name,
      itemId: entry.id,
      method: 'GET',
      target: entry.target,
      route,
      requestHeaders: {},
      response: await request(route, { token }),
    });
  }
} catch (error) {
  outcomeError = error;
} finally {
  if (instance) lifecycle = await stopReference(instance, token);

  const sourceInputsAfter = await sourceInputDigests();
  const sourceInputsUnchanged = stableDigestRecord(sourceInputsAfter) === stableDigestRecord(sourceInputsBefore);
  const recorderCopyBound = copyBindings.copiedRecorderSha256 === sourceInputsBefore.recorderSha256;
  const sourceBundleBound = copyBindings.bundledSourceDatabaseSha256 === sourceInputsBefore.sourceDatabaseSha256;
  const databaseCopyBound = copyBindings.copiedDatabaseSha256 === sourceInputsBefore.sourceDatabaseSha256;
  const launchBound = launchCommandBound && launchDllSha256 === sourceInputsBefore.dllSha256;
  const captureChecks = remoteContract(records);
  const capture = {
    origin,
    targetProvenance,
    publicTargets: cases.map(({ name, target }) => ({ name, target })),
    records,
  };
  await writeFile(path.join(nativeRun, 'native-http.json'), json(capture), { flag: 'wx' });
  const contract = records.map(record => ({
    name: record.name,
    itemId: record.itemId,
    method: record.method,
    target: record.target,
    requestHeaders: record.requestHeaders,
    status: record.response.status,
    size: record.response.size,
    sha256: record.response.sha256,
    bodyComplete: record.response.bodyReadError === null,
    location: record.response.headers.location ?? null,
    headers: Object.fromEntries(responseHeaders
      .filter(name => Object.hasOwn(record.response.headers, name))
      .map(name => [name, record.response.headers[name]])),
  }));
  await writeFile(path.join(evidence, 'native-contract.json'), json(contract), { flag: 'wx' });

  const sourceBindings = {
    before: sourceInputsBefore,
    after: sourceInputsAfter,
    copies: {
      recorder: { path: 'record-native.mjs', sha256: copyBindings.copiedRecorderSha256 },
      databaseSource: { path: 'source-initial.db', sha256: copyBindings.bundledSourceDatabaseSha256 },
      databaseCopyBeforeSeed: {
        stage: 'immediately-after-copy-before-seed',
        persistedArtifact: false,
        sha256: copyBindings.copiedDatabaseSha256,
      },
    },
    launch: {
      executable: dotnet,
      dll,
      dllSha256: launchDllSha256,
      command: instance?.command ?? null,
    },
    checks: { recorderCopyBound, sourceBundleBound, databaseCopyBound, launchBound, sourceInputsUnchanged },
  };
  await writeFile(path.join(nativeRun, 'source-bindings.json'), json(sourceBindings), { flag: 'wx' });
  const summary = {
    passed: !outcomeError && captureChecks.passed
      && lifecycle.shutdownStatus === 204 && lifecycle.result?.code === 0 && lifecycle.result?.signal === null
      && lifecycle.pidGone && lifecycle.portReleased
      && recorderCopyBound && sourceBundleBound && databaseCopyBound && launchBound && sourceInputsUnchanged,
    cases: records.length,
    processResult: lifecycle.result,
    cleanShutdown: lifecycle.shutdownStatus === 204,
    pidGone: lifecycle.pidGone,
    nativePortAvailable: lifecycle.portReleased,
    inputSha256: copyBindings.copiedRecorderSha256,
    sourceDatabaseSha256: sourceInputsBefore.sourceDatabaseSha256,
    dllSha256: sourceInputsBefore.dllSha256,
    checks: {
      statusesValid: captureChecks.statusesValid,
      bodiesComplete: captureChecks.bodiesComplete,
      contentValid: captureChecks.contentValid,
      headersValid: captureChecks.headersValid,
      provenanceValid: captureChecks.provenanceValid,
      recorderCopyBound,
      sourceBundleBound,
      databaseCopyBound,
      launchBound,
      sourceInputsUnchanged,
    },
    contractFailures: captureChecks.failures,
    observationScope: targetProvenance.observationScope,
    error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
  };
  await writeFile(path.join(nativeRun, 'summary.json'), json(summary), { flag: 'wx' });
  if (!summary.passed) throw new Error(`Public remote static oracle failed: ${JSON.stringify(summary.error ?? {
    checks: summary.checks, processResult: summary.processResult, failures: summary.contractFailures,
  })}`);
  console.log(JSON.stringify({
    evidence: path.relative(repo, evidence), cases: records.length, processResult: lifecycle.result,
    nativePortAvailable: lifecycle.portReleased, pidGone: lifecycle.pidGone,
  }));
}
