import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, sha256 } from '../validation/inventory.js';
import { captureInputIdentity } from '../validation/inputs.js';
import { repositoryRoot, validationExecutable, validationOutputRoot } from '../validation/paths.js';
import { applyInputIdentity, classify, provisionedServices, provisionedTools, restrictToRequested } from './scope.js';
import { affectedUnavailable, applyAffectedSelection, changedFilesForEvent, selectAffected } from './affected.js';

const log = message => console.log(`[ci ${new Date().toISOString()}] ${message}`);
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function preparing(label, operation) {
  const started = Date.now();
  const timer = setInterval(() => log(`${label} (${Math.round((Date.now() - started) / 1000)} seconds).`), 60000);
  try { return await operation(); }
  finally { clearInterval(timer); }
}

async function execute(scopeFile, output, environment) {
  const timeout = Number(environment.MEDIAMANAGER_CI_TIMEOUT_MS || 100 * 60 * 1000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('MEDIAMANAGER_CI_TIMEOUT_MS must be a positive integer.');
  const args = [fileURLToPath(new URL('./execute.js', import.meta.url)), scopeFile, output];
  const child = spawn(process.execPath, args, { cwd: repositoryRoot, env: environment, windowsHide: true,
    detached: process.platform !== 'win32', stdio: 'inherit' });
  const started = Date.now();
  let timedOut = false, cancelled = false;
  const terminate = () => {
    if (!child.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') log(`Cannot terminate validation: ${error.message}`); } }
  };
  const onCancel = () => { cancelled = true; log('Cancelling the validation process tree.'); terminate(); };
  process.once('SIGINT', onCancel); process.once('SIGTERM', onCancel);
  const heartbeat = setInterval(() => log(`Strict validation still running (${Math.round((Date.now() - started) / 1000)} seconds).`), 60000);
  const timer = setTimeout(() => {
    timedOut = true;
    log(`Strict validation exceeded ${timeout} ms; terminating its process tree.`);
    terminate();
  }, timeout);
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { exitCode, timedOut, cancelled, elapsedMilliseconds: Date.now() - started };
  } finally {
    clearInterval(heartbeat); clearTimeout(timer);
    process.removeListener('SIGINT', onCancel); process.removeListener('SIGTERM', onCancel);
  }
}

function markdown(scope, result) {
  const lines = ['## Cross-platform CI validation', '',
    `Platform: ${scope.platform}. Discovered: **${scope.discovered.length}**. Selected: **${scope.selected.length}**. Excluded: **${scope.excluded.length}**.`, '',
    `Selection mode: **${scope.impact.mode}**. Event: ${scope.impact.event ?? 'local/manual'}.`, '',
    ...(scope.impact.baseSha ? [`Comparison: \`${scope.impact.baseSha}\` → \`${scope.impact.headSha}\`.`, ''] : []),
    ...(scope.impact.fallbackReasons.length ? ['Automatic narrowing fell back to all available tests:', '',
      ...scope.impact.fallbackReasons.map(reason => `- ${reason.code}: ${String(reason.path ?? reason.consumer ?? reason.detail ?? '').replaceAll('\n', ' ')}`), ''] : []),
    ...(scope.impact.mode === 'not-applicable' ? ['No tests executed: every changed file is on the documentation allowlist and has no declared consumer.', ''] : []),
    `Outcome: **${result.outcome}**. This is an explicit available-input subset; release full-profile acceptance remains separate.`, '',
    'All selected tests retain the strict zero-failure, zero-skip, registration and unchanged-input gates. Test failures never change selection.', '',
    '### Excluded files', '', '| Test | Dependency or scope reason |', '| --- | --- |'];
  for (const record of scope.excluded) lines.push(`| ${record.path} | ${[...new Set(record.reasons.map(reason =>
    [reason.code, reason.service ?? reason.tool ?? reason.input ?? reason.filename ?? reason.expression ?? reason.detail ?? reason.consumer].filter(Boolean).join(': ')))].join('<br>').replaceAll('|', '\\|')} |`);
  if (!scope.excluded.length) lines.push('| None | All discovered test files selected |');
  if (scope.infrastructureErrors.length) lines.push('', '### Infrastructure errors', '', '```json', JSON.stringify(scope.infrastructureErrors, null, 2), '```');
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some(argument => argument !== '--plan-only')) throw new Error('Only --plan-only is supported.');
  const planOnly = argv.includes('--plan-only');
  if (!planOnly && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Test execution is reserved for GitHub Actions; use --plan-only locally.');
  const environment = { ...process.env };
  for (const name of provisionedTools) {
    const candidate = validationExecutable(name, environment);
    try { environment[`MEDIAMANAGER_${name.toUpperCase()}`] = await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const output = path.join(validationOutputRoot(environment), `ci-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  log(`Discovering test dependencies; evidence: ${output}`);
  const dependencies = await preparing('Discovering dependencies', () => inventory(environment));
  await save(path.join(output, 'inventory.json'), dependencies);
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, windowsHide: true, encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Cannot identify files shipped by the repository.');
  const tracked = new Set(git.stdout.split('\0').filter(Boolean));
  const classification = await preparing('Classifying available dependencies', () => classify({ dependencies, tracked, environment }));
  const request = restrictToRequested(classification, environment.MEDIAMANAGER_CI_TEST_FILES ?? '');
  let impact = { schemaVersion: 1, mode: request.requested.length ? 'exact' : 'allavailable',
    event: environment.GITHUB_EVENT_NAME ?? null, baseSha: null, headSha: null, changes: [],
    fallbackReasons: [], affected: [], matches: [], documentationOnly: [] };
  if (!request.requested.length && ['push', 'pull_request'].includes(environment.GITHUB_EVENT_NAME)) {
    const comparison = await preparing('Comparing candidate changes', () => changedFilesForEvent(environment));
    impact = selectAffected({ dependencies, tracked, comparison, environment });
    applyAffectedSelection(classification, impact);
  }
  await save(path.join(output, 'impact.json'), impact);
  const candidates = classification.records.filter(record => record.selected).map(record => record.path);
  await save(path.join(output, 'initial-selection.json'), { candidates, impact, records: classification.records });
  log(`Selection mode: ${impact.mode}${impact.fallbackReasons.length ? '; ' + impact.fallbackReasons.map(reason => reason.code).join(', ') : ''}.`);
  log(`Discovered ${classification.records.length} files; capturing inputs for ${candidates.length} candidates.`);
  // Runtime tools/services are provisioned by the workflow and authoritatively
  // probed by the strict runner. Do not exclude tests if provisioning is broken.
  const identity = impact.mode === 'not-applicable' ? null : await preparing('Capturing input identity', () => captureInputIdentity({ selected: candidates, dependencies, environment,
    preflight: { ready: true, services: [], tools: [] } }));
  const infrastructureErrors = [...request.infrastructureErrors,
    ...(identity ? applyInputIdentity(classification, identity, tracked) : []), ...affectedUnavailable(classification, impact)];
  for (const filename of request.requested) {
    const record = classification.records.find(record => record.path === filename);
    if (!record.selected && !infrastructureErrors.some(error => error.code === 'requested-test-unavailable' && error.filename === filename)) {
      infrastructureErrors.push({ code: 'requested-test-unavailable', filename, reasons: record.reasons });
    }
  }
  const scope = { schemaVersion: 1, profile: 'ci-available', phaseAcceptance: false, createdAt: new Date().toISOString(),
    platform: process.platform, node: process.version, planOnly, requested: request.requested, impact,
    selectionPolicy: 'Manual empty input selects all available tests; an exact request retains its required files. Push/PR narrow only added/modified test sources with declared source/input owners or reviewed documentation with no consumers; production, resource, global and unresolved changes fall back to all available tests. Unavailable affected tests fail the attempt. Scope freezes before execution; test failures never narrow it. Release full-profile acceptance remains separate.',
    provisionedServices, provisionedTools, discovered: classification.records.map(record => record.path),
    selected: classification.records.filter(record => record.selected).map(record => record.path),
    excluded: classification.records.filter(record => !record.selected),
    records: classification.records, infrastructureErrors, inputEntriesSha256: identity?.entriesSha256 ?? null };
  scope.selectionSha256 = sha256(JSON.stringify(scope.selected));
  await save(path.join(output, 'inputs-plan.json'), identity);
  const scopeFile = path.join(output, 'scope.json'); await save(scopeFile, scope);
  log(`Scope frozen: ${scope.selected.length} selected, ${scope.excluded.length} excluded. Full reasons: ${scopeFile}`);
  const notApplicable = impact.mode === 'not-applicable' && !infrastructureErrors.length;
  let result = { schemaVersion: 1, phaseAcceptance: false, outcome: planOnly ? 'planned' : notApplicable ? 'not-applicable' : 'incomplete', executed: false,
    selectionSha256: scope.selectionSha256 };
  if (!planOnly && !infrastructureErrors.length && scope.selected.length) {
    const strictOutput = path.join(output, 'strict');
    log('Starting strict validation of the frozen selection.');
    const execution = await execute(scopeFile, strictOutput, environment);
    let strictResult;
    try { strictResult = JSON.parse(await readFile(path.join(strictOutput, 'result.json'), 'utf8')); }
    catch (error) { strictResult = { outcome: 'incomplete', error: error.message }; }
    const unchangedSelection = JSON.stringify(strictResult.selected) === JSON.stringify(scope.selected);
    result = { ...result, ...execution, executed: strictResult.executed === true, strictOutput, unchangedSelection,
      outcome: execution.exitCode === 0 && !execution.timedOut && !execution.cancelled && unchangedSelection && strictResult.outcome === 'passed' ? 'passed' : 'failed',
      strictOutcome: strictResult.outcome, counts: strictResult.counts };
  }
  await save(path.join(output, 'result.json'), result);
  const summary = markdown(scope, result);
  await writeFile(path.join(output, 'summary.md'), summary, { flag: 'wx' });
  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, summary);
  log(`Finished: ${result.outcome}; ${scope.selected.length} selected, ${scope.excluded.length} excluded.`);
  return planOnly ? infrastructureErrors.length || !scope.selected.length && !notApplicable ? 2 : 0
    : ['passed', 'not-applicable'].includes(result.outcome) ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 2; });
}
