import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { dependencyClosure, dependencyVariables, describeFile, filesIn, inventory, sha256 } from './inventory.js';
import { captureInputIdentity, inputsUnchanged } from './inputs.js';
import { assertIsolatedOutput, repositoryRoot, validationExecutable, validationOutputRoot } from './paths.js';
import registrationReporter, { progressLineLimit, progressPrefix, progressRecord } from './tap-registration-reporter.js';

void registrationReporter;
const registrationReporterUrl = new URL('./tap-registration-reporter.js', import.meta.url).href;

export async function validationPhase(label, operation, { environment = process.env, write = text => process.stderr.write(text) } = {}) {
  if (environment.GITHUB_ACTIONS !== 'true') return operation();
  const started = Date.now();
  const report = state => write(`[strict ${new Date().toISOString()}] ${label}: ${state} (${Math.round((Date.now() - started) / 1000)}s).\n`);
  report('started');
  const heartbeat = setInterval(() => report('still running'), 60000);
  heartbeat.unref();
  try { const result = await operation(); report('completed'); return result; }
  catch (error) { report('failed'); throw error; }
  finally { clearInterval(heartbeat); }
}

export function progressForwarder({ environment = process.env, selected, write = text => process.stderr.write(text) }) {
  if (environment.GITHUB_ACTIONS !== 'true') return () => {};
  const selectedSet = new Set(selected), decoder = new StringDecoder('utf8');
  let pending = '', dropping = false;
  return chunk => {
    const text = decoder.write(chunk);
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset), end = newline === -1 ? text.length : newline;
      if (!dropping) {
        if (pending.length + end - offset > progressLineLimit) { pending = ''; dropping = true; }
        else pending += text.slice(offset, end);
      }
      if (newline === -1) break;
      if (!dropping && pending.startsWith(progressPrefix)) {
        let value;
        try { value = JSON.parse(pending.slice(progressPrefix.length)); } catch { /* Keep malformed output only in stderr.txt. */ }
        const record = progressRecord(value, selectedSet);
        if (record) write(progressPrefix + JSON.stringify(record) + '\n');
      }
      pending = ''; dropping = false; offset = newline + 1;
    }
  };
}

export const baseTests = Object.freeze([
  'tests/core/authorization.test.js', 'tests/core/password.test.js', 'tests/core/composite-format.test.js',
  'tests/storage/vfs.test.js', 'tests/storage/alist.test.js', 'tests/storage/webdav.test.js', 'tests/database/sqlite.test.js',
  'tests/compat/differential.test.js',
]);

export function parseTapSummary(output) {
  const counts = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))];
    counts[key] = matches.length === 1 ? Number(matches[0][1]) : null;
  }
  return counts;
}

export function successfulRun(exitCode, counts) {
  return exitCode === 0 && Number.isInteger(counts.tests) && counts.tests > 0 && counts.pass === counts.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0);
}

export function resultOutcome(exitCode, counts, {
  candidateUnchanged, currentInputUnchanged, currentReleaseInputReady, scopeComplete = true, registrationComplete = true,
}) {
  if (!candidateUnchanged || !currentInputUnchanged || !currentReleaseInputReady || !scopeComplete || !registrationComplete) return 'incomplete';
  return successfulRun(exitCode, counts) ? 'passed' : 'failed';
}

export function fullProfileNarrowingEnvironment(environment) {
  return Object.keys(environment)
    .filter(key => /^MEDIAMANAGER_[A-Z0-9_]+_DIALECT$/u.test(key) && environment[key]).sort();
}

export function fullProfileRuntimeInjection(environment, execArgv = process.execArgv) {
  const values = [];
  for (const key of ['NODE_OPTIONS', 'NODE_PATH']) if (environment[key]) values.push(key);
  const injectionOptions = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
  for (let index = 0; index < execArgv.length; index++) {
    const argument = execArgv[index];
    const option = argument.split('=', 1)[0];
    if (injectionOptions.has(option)) values.push(`execArgv:${option}`);
  }
  return [...new Set(values)].sort();
}

export function toolVersionArguments(name) {
  if (name === 'dotnet' || name === 'git') return ['--version'];
  if (name === 'ffmpeg' || name === 'ffprobe') return ['-version'];
  return null;
}

export function argumentsFor(argv) {
  const options = { profile: 'base', output: null, config: null, preflightOnly: false, tests: [], concurrency: 1 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') { options.tests = argv.slice(index + 1); break; }
    if (argument === '--preflight-only') options.preflightOnly = true;
    else if (['--profile', '--output', '--config', '--concurrency'].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${argument}.`);
      options[argument.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${argument}.`);
  }
  if (!['base', 'full'].includes(options.profile)) throw new Error('Profile must be base or full.');
  if (options.profile === 'full' && options.tests.length) {
    throw new Error('The full profile cannot be combined with an explicit test subset.');
  }
  options.concurrency = Number(options.concurrency);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  return options;
}

async function readConfig(filename) {
  if (!filename) return {};
  const config = JSON.parse(await readFile(path.resolve(repositoryRoot, filename), 'utf8'));
  if (config.schemaVersion !== 1 || typeof config.environment !== 'object' || !config.environment || Array.isArray(config.environment)) {
    throw new Error('Configuration requires schemaVersion: 1 and an environment object.');
  }
  for (const [key, value] of Object.entries(config.environment)) {
    if (!(key === 'TZ' || /^MEDIAMANAGER_[A-Z0-9_]+$/u.test(key)) || typeof value !== 'string') {
      throw new Error(`Invalid validation environment entry: ${key}.`);
    }
  }
  return config.environment;
}

async function preflight(testPaths, dependencies, environment, { fullProfile = false } = {}) {
  const selected = dependencyClosure(dependencies, testPaths);
  const requiredServices = [...new Set(selected.flatMap(entry => entry.services))].sort();
  const services = [];
  for (const name of requiredServices) {
    const variable = dependencyVariables[name];
    const value = environment[variable];
    let result = { name, variable, configured: Boolean(value), available: false };
    if (value && name === 'postgres') {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: value, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        const response = await client.query('SELECT version() AS version, current_database() AS database, current_user AS role, '
          + 'inet_server_addr()::text AS address, inet_server_port() AS port, pg_postmaster_start_time() AS started_at');
        result.available = true;
        result.version = response.rows[0].version;
        result.identity = response.rows[0];
      } catch (error) { result.errorCode = error.code || error.name; }
      finally { await client.end().catch(() => {}); }
    } else if (value) {
      const description = await describeFile(path.resolve(repositoryRoot, value), { recursive: false });
      result = { ...result, ...description };
    }
    services.push(result);
  }
  const tools = [];
  const names = [...new Set(selected.flatMap(entry => entry.tools))].sort();
  for (const name of names) {
    const executable = validationExecutable(name, environment);
    const description = await describeFile(executable, { recursive: false });
    const args = toolVersionArguments(name);
    const spawnOptions = { cwd: repositoryRoot, env: environment, windowsHide: true, encoding: 'utf8', timeout: 10000 };
    let result = null;
    if (description.available && args && name === 'dotnet') {
      result = spawnSync(validationExecutable('dotnet', environment), ['--version'], spawnOptions);
    } else if (description.available && args && name === 'git') {
      result = spawnSync(validationExecutable('git', environment), ['--version'], spawnOptions);
    } else if (description.available && args && name === 'ffmpeg') {
      result = spawnSync(validationExecutable('ffmpeg', environment), ['-version'], spawnOptions);
    } else if (description.available && args && name === 'ffprobe') {
      result = spawnSync(validationExecutable('ffprobe', environment), ['-version'], spawnOptions);
    }
    tools.push({ name, executable, available: description.available && (!result || result.status === 0),
      ...(description.sha256 ? { sha256: description.sha256, bytes: description.bytes } : {}),
      ...(result ? { version: (result.stdout || result.stderr || '').split(/\r?\n/u)[0] } : {}),
      ...(result?.error ? { errorCode: result.error.code } : {}) });
  }
  const unavailableReferences = selected.flatMap(entry => entry.declaredReferences
    .filter(reference => reference.required && reference.available === false).map(reference => ({ consumer: entry.path, ...reference })));
  const unresolvedExecutables = selected.flatMap(entry => (entry.unresolvedExecutables || [])
    .map(executable => ({ consumer: entry.path, ...executable })));
  const narrowingEnvironment = fullProfile ? fullProfileNarrowingEnvironment(environment) : [];
  const runtimeInjection = fullProfile ? fullProfileRuntimeInjection(environment) : [];
  return { services, tools, unavailableReferences, unresolvedExecutables,
    conditionalRegistration: selected.filter(entry => entry.conditionalRegistration).map(entry => entry.path),
    narrowingEnvironment, runtimeInjection,
    ready: services.every(service => service.available) && tools.every(tool => tool.available)
      && unavailableReferences.length === 0 && unresolvedExecutables.length === 0
      && !selected.some(entry => entry.conditionalRegistration)
      && narrowingEnvironment.length === 0 && runtimeInjection.length === 0 };
}

function sameCandidate(left, right) {
  return left.head === right.head && left.entriesSha256 === right.entriesSha256
    && JSON.stringify(left.status) === JSON.stringify(right.status);
}

export function inventoryCandidateDifferences(dependencies, candidate) {
  const candidateEntries = new Map(candidate.entries.map(entry => [entry.path.replaceAll('\\', '/'), entry]));
  return dependencies.entries.flatMap(entry => {
    const actual = candidateEntries.get(entry.path);
    if (!actual) return [{ path: entry.path, reason: 'missing-from-candidate' }];
    if (!actual.available) return [{ path: entry.path, reason: 'candidate-entry-unavailable' }];
    if (actual.sha256 !== entry.sha256) return [{ path: entry.path, reason: 'sha256-mismatch' }];
    return [];
  });
}

async function candidateIdentity() {
  const git = args => spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain=v1', '-z']);
  const files = git(['ls-files', '-c', '-o', '--exclude-standard', '-z']);
  if ([head, status, files].some(result => result.status !== 0)) throw new Error('Cannot capture candidate Git identity.');
  const entries = [];
  for (const filename of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
    const description = await describeFile(path.resolve(repositoryRoot, filename));
    entries.push({ path: filename, available: description.available,
      ...(description.sha256 ? { sha256: description.sha256, bytes: description.bytes } : {}) });
  }
  return { head: head.stdout.trim(), status: status.stdout.split('\0').filter(Boolean), entries,
    entriesSha256: sha256(JSON.stringify(entries)) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  const environment = { ...process.env, ...await readConfig(options.config) };
  const phase = (label, operation) => validationPhase(label, operation, { environment });
  const output = options.output ? path.resolve(repositoryRoot, options.output)
    : path.join(validationOutputRoot(environment), `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`);
  assertIsolatedOutput(output, environment);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const candidateBeforeInventory = await phase('prepare candidate identity', () => candidateIdentity());
  const dependencies = await phase('prepare dependency inventory', () => inventory(environment));
  const discovered = dependencies.entries.filter(entry => entry.test).map(entry => entry.path);
  const selected = (options.tests.length ? options.tests : options.profile === 'full' ? discovered : baseTests)
    .map(filename => path.relative(repositoryRoot, path.resolve(repositoryRoot, filename)).replaceAll('\\', '/'));
  if (selected.length === 0 || selected.some(filename => !discovered.includes(filename))) throw new Error('Every selected path must name a discovered .test.js file.');
  const notSelected = discovered.filter(filename => !selected.includes(filename));
  const inputs = await phase('prepare tool and service preflight', () => preflight(selected, dependencies, environment, { fullProfile: options.profile === 'full' }));
  const inputIdentity = await phase('prepare input identity', () => captureInputIdentity({ selected, dependencies, preflight: inputs, environment }));
  const candidate = await phase('prepare frozen candidate identity', () => candidateIdentity());
  const candidatePreparationStable = sameCandidate(candidateBeforeInventory, candidate);
  const inventoryDifferences = inventoryCandidateDifferences(dependencies, candidate);
  const expectedTests = candidate.entries.filter(entry => /^(?:tests\/).+\.test\.js$/u.test(entry.path.replaceAll('\\', '/')))
    .map(entry => entry.path.replaceAll('\\', '/'));
  const missingTests = expectedTests.filter(filename => !discovered.includes(filename));
  const allDiscoveredSelected = notSelected.length === 0;
  const scopeComplete = options.profile !== 'full' || allDiscoveredSelected && missingTests.length === 0
    && candidatePreparationStable && inventoryDifferences.length === 0;
  const record = { schemaVersion: 1, startedAt: new Date().toISOString(), profile: options.profile,
    outcome: 'incomplete', executed: false, phaseAcceptance: false, selected, notSelected,
    allDiscoveredSelected, missingTests, candidatePreparationStable, inventoryDifferences, scopeComplete,
    node: process.version, executable: process.execPath, platform: process.platform, architecture: process.arch,
    timezone: environment.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    configuration: Object.fromEntries(Object.entries(environment).filter(([key]) => key === 'TZ' || key.startsWith('MEDIAMANAGER_'))
      .map(([key, value]) => [key, /(?:PASSWORD|TOKEN|SECRET|POSTGRES)/u.test(key) ? { configured: Boolean(value) } : value])),
    candidateEntriesSha256: candidate.entriesSha256, currentInputEntriesSha256: inputIdentity.entriesSha256,
    historicalArchiveComplete: inputIdentity.historicalArchiveComplete, historicalArchive: inputIdentity.historicalArchive,
    preflight: inputs };
  const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await save('inventory.json', dependencies);
  await save('candidate.json', candidate);
  await save('inputs-before.json', inputIdentity);
  if (!options.preflightOnly && inputIdentity.currentReleaseInputReady && scopeComplete) {
    const registrationOutput = path.join(output, 'test-registrations.json');
    const args = ['--test', `--test-reporter=${registrationReporterUrl}`, `--test-concurrency=${options.concurrency}`, ...selected];
    record.command = { executable: process.execPath, args };
    const raw = createWriteStream(path.join(output, 'test.tap'), { flags: 'wx' });
    const errors = createWriteStream(path.join(output, 'stderr.txt'), { flags: 'wx' });
    const childEnvironment = { ...environment, MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: registrationOutput,
      MEDIAMANAGER_TEST_REGISTRATION_ROOT: repositoryRoot,
      MEDIAMANAGER_TEST_REGISTRATION_SELECTED: JSON.stringify(selected) };
    const code = await phase(`execute ${selected.length} test files`, async () => {
      const child = spawn(process.execPath, args, { cwd: repositoryRoot, env: childEnvironment,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(raw);
      child.stderr.pipe(errors);
      const forward = progressForwarder({ environment, selected });
      child.stderr.on('data', forward);
      const streams = Promise.all([raw, errors].map(stream => new Promise((resolve, reject) => {
        stream.once('finish', resolve); stream.once('error', reject);
      })));
      try {
        const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        await streams;
        return exitCode;
      } finally { child.stderr.removeListener('data', forward); }
    });
    const counts = parseTapSummary(await readFile(path.join(output, 'test.tap'), 'utf8'));
    Object.assign(record, { executed: true, exitCode: code, counts });
    let registration = { files: [], missing: selected };
    try { registration = JSON.parse(await readFile(registrationOutput, 'utf8')); }
    catch (error) { registration.errorCode = error.code || error.name; }
    record.testRegistrations = registration;
    record.registrationComplete = registration.missing.length === 0
      && registration.files.length === selected.length;
    const candidateBeforeAfterInventory = await phase('audit candidate identity', () => candidateIdentity());
    const dependenciesAfter = await phase('audit dependency inventory', () => inventory(environment));
    record.preflightAfter = await phase('audit tool and service preflight', () => preflight(selected, dependenciesAfter, environment, { fullProfile: options.profile === 'full' }));
    const inputsAfter = await phase('audit input identity', () => captureInputIdentity({ selected, dependencies: dependenciesAfter, preflight: record.preflightAfter, environment }));
    const after = await phase('audit final candidate identity', () => candidateIdentity());
    record.inventoryDifferencesAfter = inventoryCandidateDifferences(dependenciesAfter, after);
    record.candidateUnchanged = sameCandidate(candidate, candidateBeforeAfterInventory)
      && sameCandidate(candidateBeforeAfterInventory, after) && record.inventoryDifferencesAfter.length === 0;
    await save('candidate-after.json', after);
    await save('inputs-after.json', inputsAfter);
    record.currentInputUnchanged = inputsUnchanged(inputIdentity, inputsAfter);
    record.currentInputEntriesSha256After = inputsAfter.entriesSha256;
    record.historicalArchiveCompleteAfter = inputsAfter.historicalArchiveComplete;
    record.historicalArchiveAfter = inputsAfter.historicalArchive;
    record.scopeComplete &&= record.registrationComplete;
    record.outcome = resultOutcome(code, counts, { candidateUnchanged: record.candidateUnchanged,
      currentInputUnchanged: record.currentInputUnchanged, currentReleaseInputReady: inputsAfter.currentReleaseInputReady,
      scopeComplete: record.scopeComplete, registrationComplete: record.registrationComplete });
  }
  record.finishedAt = new Date().toISOString();
  await save('result.json', record);
  console.log(JSON.stringify({ output, outcome: record.outcome, executed: record.executed, counts: record.counts,
    selected: selected.length, notSelected: record.notSelected.length,
    currentReleaseInputReady: inputIdentity.currentReleaseInputReady,
    historicalArchiveComplete: inputIdentity.historicalArchiveComplete }, null, 2));
  return record.outcome === 'passed' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
