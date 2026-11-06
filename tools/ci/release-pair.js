import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validCurrentInputReceipt } from '../validation/input-receipt.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = values => [...values].sort();
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const positiveId = value => /^[1-9]\d*$/u.test(String(value)) && Number.isSafeInteger(Number(value));
const pairPlatforms = { 'ubuntu-24.04': 'linux', 'windows-2025': 'win32', 'macos-15': 'darwin' };
const unmetPrerequisites = ['Product capability acceptance evidence is not supplied to this CI gate.',
  'Production-scale complete-instance validation and final release review require separate evidence.'];
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const preflightDirectory = 'release-pair-preflight';
const roundDirectories = ['strict-full-1', 'strict-full-2'];
const preflightFiles = ['result.json', 'candidate.json', 'inputs-before.json'];
const roundFiles = [...preflightFiles, 'candidate-after.json', 'inputs-after.json', 'test-registrations.json', 'test.tap', 'stderr.txt'];

export function releasePairEnabled(environment) {
  const value = environment.MEDIAMANAGER_CI_RELEASE_PAIR ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error('MEDIAMANAGER_CI_RELEASE_PAIR must be true or false.');
  return value === 'true';
}

export function validateReleasePairEnvironment(environment) {
  if (!releasePairEnabled(environment)) return;
  if (environment.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Release pairs require an explicit workflow dispatch.');
  if (environment.MEDIAMANAGER_CI_PLATFORM !== 'all') throw new Error('Release pairs require all three platforms.');
  if ((environment.MEDIAMANAGER_CI_TEST_FILES ?? '').split(/[,\r\n]+/u).some(value => value.trim())) {
    throw new Error('Release pairs cannot contain an explicit test subset.');
  }
  if ([environment.MEDIAMANAGER_CI_SHARD ?? '1', environment.MEDIAMANAGER_CI_SHARDS ?? '1'].some(value => value !== '1')) {
    throw new Error('Release pairs cannot be sharded.');
  }
  if (!/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? '')) throw new Error('Release pairs require the exact workflow candidate.');
}

function scopeErrors(scope) {
  return scope.schemaVersion !== 1 || scope.profile !== 'full' || scope.releasePair !== true || scope.planOnly !== false
    || scope.infrastructureErrors?.length !== 0 || scope.requested?.length !== 0
    || scope.excluded?.length !== 0 || !Array.isArray(scope.discovered) || !scope.discovered.length
    || !equal(scope.selected, scope.discovered) || new Set(scope.selected).size !== scope.selected.length
    || scope.sharding?.index !== 1 || scope.sharding?.total !== 1
    || scope.selectionSha256 !== hash(JSON.stringify(scope.selected))
    ? ['The pair scope must retain every discovered file without subsets or shards.'] : [];
}

async function bundle(output, preflightOnly) {
  const files = {}, evidence = [], errors = [];
  const names = preflightOnly ? preflightFiles : roundFiles;
  for (const name of names) {
    try {
      const bytes = await readFile(path.join(output, name));
      files[name] = name.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
      evidence.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    } catch (error) { errors.push(`${name}: ${error.code ?? error.name}`); }
  }
  return { files, evidence, errors };
}

export async function stageReleasePairEvidence(results, output) {
  const roots = (await readdir(results, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('ci-'));
  if (roots.length > 1) throw new Error('The full-pair verification source is ambiguous.');
  const files = ['environment.json', 'postgres-audit.json'];
  if (roots.length) {
    const root = roots[0].name;
    files.push(...['scope.json', 'release-pair.json', 'release-pair-frozen.json'].map(name => path.join(root, name)),
      ...preflightFiles.map(name => path.join(root, preflightDirectory, name)),
      ...roundDirectories.flatMap(directory => roundFiles.map(name => path.join(root, directory, name))));
  }
  await mkdir(output);
  for (const filename of files) {
    const destination = path.join(output, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    try { await copyFile(path.join(results, filename), destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function candidateValid(candidate, expectedHead) {
  return candidate?.head === expectedHead && equal(candidate.status, []) && Array.isArray(candidate.entries)
    && candidate.entries.length > 0 && candidate.entriesSha256 === hash(JSON.stringify(candidate.entries));
}

export async function inspectReleaseEvidence(output, scope, expectedHead, { preflightOnly = false, execution } = {}) {
  const { files, evidence, errors } = await bundle(output, preflightOnly);
  const result = files['result.json'], candidate = files['candidate.json'], input = files['inputs-before.json'];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(result?.profile === 'full' && result.platform === scope.platform && result.allDiscoveredSelected === true && result.scopeComplete === true
    && equal(result.selected, scope.selected) && equal(result.notSelected, []) && equal(result.missingTests, []), 'The strict full scope is incomplete or changed.');
  check(result?.candidatePreparationStable === true && equal(result.inventoryDifferences, []) && result.preflight?.ready === true, 'Preparation did not preserve a ready candidate.');
  check(candidateValid(candidate, expectedHead) && result?.candidateEntriesSha256 === candidate?.entriesSha256, 'The candidate is not the exact clean workflow head.');
  check(input?.currentReleaseInputReady === true && input.preflightReady === true && validDigest(input.entriesSha256)
    && validCurrentInputReceipt(input) && result?.currentInputEntriesSha256 === input.entriesSha256,
  'The protected current release input identity is invalid or unavailable.');
  if (preflightOnly) {
    check(result?.executed === false && result.outcome === 'incomplete' && !execution?.timedOut && !execution?.cancelled
      && (!execution || execution.exitCode === 2), 'The shared preflight did not finish normally without executing tests.');
  } else {
    const candidateAfter = files['candidate-after.json'], inputAfter = files['inputs-after.json'];
    check(result?.outcome === 'passed' && result.executed === true && result.exitCode === 0
      && (!execution || execution.exitCode === 0 && !execution.timedOut && !execution.cancelled), 'The strict full execution did not pass.');
    check(result?.testResources?.released === true && equal(result.testResources.remaining, []),
      'The strict full run did not release its shared test resources.');
    check(result?.candidateUnchanged === true && candidateValid(candidateAfter, expectedHead) && equal(candidate, candidateAfter)
      && equal(result?.inventoryDifferencesAfter, []), 'The candidate changed during execution.');
    check(result?.currentInputUnchanged === true && result.preflightAfter?.ready === true
      && inputAfter?.currentReleaseInputReady === true && validCurrentInputReceipt(inputAfter)
      && input?.entriesSha256 === inputAfter.entriesSha256
      && result.currentInputEntriesSha256After === inputAfter.entriesSha256, 'Protected current release inputs changed during execution.');
    const registrations = files['test-registrations.json'];
    check(result?.registrationComplete === true && registrations?.missing?.length === 0 && Array.isArray(registrations?.files)
      && registrations.files.length === scope.selected.length && registrations.files.every(item => item.registrations > 0)
      && equal(result.testRegistrations, registrations)
      && equal(sorted(registrations.files.map(item => item.path)), sorted(scope.selected)), 'Per-file test registration is incomplete.');
    const tap = files['test.tap'] ?? '', counts = {};
    for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const matches = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))];
      counts[key] = matches.length === 1 ? Number(matches[0][1]) : null;
    }
    const plans = [...tap.matchAll(/^1\.\.(\d+)$/gmu)];
    const topLevelAssertions = [...tap.matchAll(/^ok \d+ - /gmu)].length;
    check(Number.isInteger(counts.tests) && counts.tests > 0 && Number.isInteger(counts.suites) && counts.suites >= 0 && counts.pass === counts.tests
      && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0)
      && plans.length === 1 && Number(plans[0][1]) === topLevelAssertions
      && equal(result?.counts, counts) && !/^\s*not ok \d+/mu.test(tap) && !/^Bail out!/mu.test(tap), 'The complete TAP summary did not pass without skips or cancellations.');
  }
  return { output, preflightOnly, verified: errors.length === 0, errors, evidence,
    executed: result?.executed === true, outcome: result?.outcome ?? 'incomplete',
    candidateHead: candidate?.head ?? null, candidateEntriesSha256: candidate?.entriesSha256 ?? null,
    currentInputEntriesSha256: input?.entriesSha256 ?? null, counts: result?.counts ?? null };
}

function sameFrozenInputs(frozen, round) {
  return frozen.candidateHead === round.candidateHead && frozen.candidateEntriesSha256 === round.candidateEntriesSha256
    && frozen.currentInputEntriesSha256 === round.currentInputEntriesSha256;
}

function pairResult(scope, frozen, rounds, errors) {
  const verified = errors.length === 0 && frozen?.verified === true && rounds.length === 2
    && rounds.every(round => round.verified && sameFrozenInputs(frozen, round));
  return { schemaVersion: 1, mode: 'release-pair', acceptanceScope: 'Two independent strict full runs on one platform using the same frozen candidate and protected current release inputs.',
    platform: scope.platform, outcome: verified ? 'passed' : 'incomplete', executed: rounds.some(round => round.executed),
    strictPairAcceptance: verified, releaseAcceptance: false, phaseAcceptance: false,
    productAcceptance: false, productionScaleAcceptance: false, unmetPrerequisites,
    selectionSha256: scope.selectionSha256, frozen: frozen ?? null, rounds, errors };
}

// Provisioning is outside this operation. The same executor/environment and one
// frozen scope are reused; no initialization or input replacement occurs here.
export async function runReleasePair({ scope, output, expectedHead, execute, log = () => {} }) {
  const errors = scopeErrors(scope), rounds = [];
  let frozen;
  try {
    if (!errors.length) {
      const preflightOutput = path.join(output, preflightDirectory);
      log('Freezing shared candidate and protected current release inputs without executing tests.');
      const execution = await execute(preflightOutput, { preflightOnly: true });
      frozen = { execution, ...await inspectReleaseEvidence(preflightOutput, scope, expectedHead, { preflightOnly: true, execution }) };
      await save(path.join(output, 'release-pair-frozen.json'), frozen);
      if (!frozen.verified) errors.push('Shared full preflight is incomplete.');
      for (const [position, directory] of roundDirectories.entries()) {
        if (errors.length) break;
        const index = position + 1, strictOutput = path.join(output, directory);
        log(`Starting independent strict full run ${index}/${roundDirectories.length} with the frozen inputs.`);
        const execution = await execute(strictOutput, { preflightOnly: false });
        const round = await inspectReleaseEvidence(strictOutput, scope, expectedHead, { execution });
        rounds.push({ index, execution, ...round });
        if (!round.verified) errors.push(`Strict full run ${index} is incomplete or failed.`);
        if (!sameFrozenInputs(frozen, round)) errors.push(`Strict full run ${index} changed the frozen candidate or protected current release inputs.`);
      }
    }
  } catch (error) { errors.push(`Pair execution stopped: ${error.code ?? error.name}`); }
  const result = pairResult(scope, frozen, rounds, errors);
  await save(path.join(output, 'release-pair.json'), result);
  return result;
}

export async function verifyReleasePair(output, scope, expectedHead) {
  const errors = scopeErrors(scope), rounds = [];
  const frozen = await inspectReleaseEvidence(path.join(output, preflightDirectory), scope, expectedHead, { preflightOnly: true });
  for (const [position, directory] of roundDirectories.entries()) {
    rounds.push({ index: position + 1, ...await inspectReleaseEvidence(path.join(output, directory), scope, expectedHead) });
  }
  if (!frozen.verified) errors.push('Shared preflight evidence is incomplete.');
  for (const round of rounds) {
    if (!round.verified) errors.push(`Strict full run ${round.index} evidence is incomplete.`);
    if (!sameFrozenInputs(frozen, round)) errors.push(`Strict full run ${round.index} differs from the frozen current release inputs.`);
  }
  const recorded = JSON.parse(await readFile(path.join(output, 'release-pair.json'), 'utf8'));
  const frozenReceipt = JSON.parse(await readFile(path.join(output, 'release-pair-frozen.json'), 'utf8'));
  if (recorded.strictPairAcceptance !== true || recorded.releaseAcceptance !== false || recorded.rounds?.length !== 2) errors.push('The recorded pair was not accepted.');
  for (let index = 0; index < rounds.length; index++) {
    if (!equal(recorded.rounds?.[index]?.evidence, rounds[index].evidence)
      || recorded.rounds?.[index]?.execution?.exitCode !== 0 || recorded.rounds[index].execution.timedOut || recorded.rounds[index].execution.cancelled) {
      errors.push(`Strict full run ${index + 1} evidence or process receipt changed.`);
    }
  }
  if (!equal(recorded.frozen, frozenReceipt) || !equal(recorded.frozen?.evidence, frozen.evidence)
    || recorded.frozen?.execution?.exitCode !== 2 || recorded.frozen.execution.timedOut || recorded.frozen.execution.cancelled) errors.push('The frozen evidence or preflight process receipt changed.');
  return pairResult(scope, frozen, rounds, errors);
}

export function selectReleasePairArtifacts({ jobs = [], available = [], expectedHead, runId, attempt }) {
  const errors = [], selected = [];
  if (!/^[a-f0-9]{40}$/u.test(expectedHead ?? '') || !positiveId(runId) || !positiveId(attempt)) {
    return { selected, errors: ['The exact workflow candidate, run and attempt are required.'] };
  }
  const fromUpload = (job, os, step, prefix) => {
    const uploads = job.steps?.filter(entry => entry.name === step) ?? [];
    const upload = uploads[0], started = Date.parse(upload?.started_at), ended = Date.parse(upload?.completed_at);
    if (uploads.length !== 1 || upload.status !== 'completed' || upload.conclusion !== 'success' || !(started <= ended)) {
      errors.push(`${os}: the effective job has no successful ${step} upload.`);
      return null;
    }
    // GitHub copies completed jobs into a retry attempt. The upload window
    // belongs to the execution that actually ran, including on carried jobs.
    const matches = available.filter(artifact => {
      if (!artifact.name?.startsWith(prefix)) return false;
      const producerAttempt = artifact.name.slice(prefix.length), created = Date.parse(artifact.created_at);
      return positiveId(producerAttempt) && Number(producerAttempt) <= Number(attempt) && positiveId(artifact.id)
        && artifact.expired === false && String(artifact.workflow_run?.id) === String(runId)
        && artifact.workflow_run?.head_sha === expectedHead && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')
        && created >= started && created <= ended;
    });
    if (matches.length !== 1) {
      errors.push(`${os}: expected one ${step} artifact from the effective job's upload.`);
      return null;
    }
    const artifact = matches[0];
    return { name: artifact.name, id: artifact.id, digest: artifact.digest,
      producerAttempt: artifact.name.slice(prefix.length), uploadedAt: artifact.created_at,
      uploadStartedAt: upload.started_at, uploadCompletedAt: upload.completed_at };
  };
  for (const [os, platform] of Object.entries(pairPlatforms)) {
    const candidates = jobs.filter(job => job.name?.startsWith(`${os} / shard 1 / `));
    const job = candidates[0];
    if (candidates.length !== 1 || String(job.run_id) !== String(runId) || job.head_sha !== expectedHead
      || String(job.run_attempt) !== String(attempt) || job.status !== 'completed' || !positiveId(job.id) || !positiveId(job.runner_id)) {
      errors.push(`${os}: the effective platform job did not complete on a runner.`);
      continue;
    }
    if (job.conclusion !== 'success') errors.push(`${os}: the effective platform job did not succeed.`);
    const core = fromUpload(job, os, 'Preserve full-pair verification evidence', `strict-pair-core-${os}-shard-1-`);
    const diagnostics = fromUpload(job, os, 'Preserve validation evidence', `validation-${os}-shard-1-`);
    if (!core || !diagnostics) continue;
    if (core.producerAttempt !== diagnostics.producerAttempt || String(core.id) === String(diagnostics.id)) {
      errors.push(`${os}: verification and diagnostic artifacts do not share their original execution.`);
      continue;
    }
    selected.push({ os, platform, ...core, effectiveJobId: job.id, diagnostics });
  }
  return { selected, errors };
}

export async function aggregateReleasePairs({ artifacts, expectedHead, runId, attempt, validationResult, jobs, available }) {
  const { selected, errors } = selectReleasePairArtifacts({ jobs, available, expectedHead, runId, attempt });
  const platforms = [];
  let names = [];
  try { names = await readdir(artifacts); }
  catch (error) { errors.push(`The artifact directory is unavailable (${error.code ?? error.name}).`); }
  if (selected.length !== Object.keys(pairPlatforms).length || !equal(sorted(names), sorted(selected.map(entry => entry.name)))) {
    errors.push('Exactly the three artifacts from the effective platform jobs are required.');
  }
  if (validationResult !== 'success') errors.push('The platform validation jobs did not all succeed.');
  for (const source of selected) {
    const { os, platform } = source;
    try {
      const artifact = path.join(artifacts, source.name);
      const ciRoots = (await readdir(artifact)).filter(name => name.startsWith('ci-'));
      if (ciRoots.length !== 1) throw new Error('AmbiguousEvidence');
      const output = path.join(artifact, ciRoots[0]);
      const scope = JSON.parse(await readFile(path.join(output, 'scope.json'), 'utf8'));
      const result = await verifyReleasePair(output, scope, expectedHead);
      const environment = JSON.parse(await readFile(path.join(artifact, 'environment.json'), 'utf8'));
      const audit = JSON.parse(await readFile(path.join(artifact, 'postgres-audit.json'), 'utf8'));
      if (scope.platform !== platform || environment.runner?.platform !== platform || environment.runner.commit !== expectedHead
        || String(environment.runner.runId) !== String(runId) || String(environment.runner.attempt) !== source.producerAttempt) {
        errors.push(`${os}: runner identity differs from the effective job's original upload.`);
      }
      if (audit.clean !== true || audit.connections?.length !== 0 || audit.leakedSchemas?.length !== 0 || audit.leakedRoles?.length !== 0
        || !equal(audit.schemas, environment.schemas) || !equal(audit.roles, environment.roles)
        || audit.database?.started_at !== environment.database?.started_at) errors.push(`${os}: PostgreSQL cleanup or identity is incomplete.`);
      if (!result.strictPairAcceptance) errors.push(`${os}: two strict full runs did not verify.`);
      platforms.push({ artifact: source.name, source, ...result });
    } catch (error) { errors.push(`${os}: evidence unavailable (${error.code ?? error.name}).`); }
  }
  if (platforms.length === 3 && !platforms.every(item => item.selectionSha256 === platforms[0].selectionSha256)) errors.push('The discovered full test sets differ across platforms.');
  return { schemaVersion: 1, mode: 'release-pair', acceptanceScope: 'Two strict full runs per platform, with the same frozen candidate and protected current release inputs within each Windows/Linux/macOS runner.',
    headSha: expectedHead, runId, attempt, outcome: errors.length ? 'incomplete' : 'passed',
    strictPairAcceptance: errors.length === 0 && platforms.length === 3, releaseAcceptance: false,
    phaseAcceptance: false, productAcceptance: false, productionScaleAcceptance: false,
    unmetPrerequisites, platforms, errors };
}
