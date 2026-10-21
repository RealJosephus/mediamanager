import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = values => [...values].sort();
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const unmetPrerequisites = ['Product capability acceptance evidence is not supplied to this CI gate.',
  'Production-scale complete-instance validation and final release review require separate evidence.'];
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

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
  const names = ['result.json', 'candidate.json', 'inputs-before.json',
    ...(!preflightOnly ? ['candidate-after.json', 'inputs-after.json', 'test-registrations.json', 'test.tap', 'stderr.txt'] : [])];
  for (const name of names) {
    try {
      const bytes = await readFile(path.join(output, name));
      files[name] = name.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
      evidence.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    } catch (error) { errors.push(`${name}: ${error.code ?? error.name}`); }
  }
  return { files, evidence, errors };
}

function inputDigest(input) {
  if (input?.schemaVersion !== 2 || !Array.isArray(input.entries)) return null;
  const { schemaVersion, scope, entriesSha256, ...identity } = input;
  return hash(JSON.stringify(identity));
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
  check(input?.ready === true && input.preflightReady === true && validDigest(input.entriesSha256)
    && inputDigest(input) === input.entriesSha256 && result?.inputEntriesSha256 === input.entriesSha256, 'The protected input identity is invalid or unavailable.');
  if (preflightOnly) {
    check(result?.executed === false && result.outcome === 'incomplete' && !execution?.timedOut && !execution?.cancelled
      && (!execution || execution.exitCode === 2), 'The shared preflight did not finish normally without executing tests.');
  } else {
    const candidateAfter = files['candidate-after.json'], inputAfter = files['inputs-after.json'];
    check(result?.outcome === 'passed' && result.executed === true && result.exitCode === 0
      && (!execution || execution.exitCode === 0 && !execution.timedOut && !execution.cancelled), 'The strict full execution did not pass.');
    check(result?.candidateUnchanged === true && candidateValid(candidateAfter, expectedHead) && equal(candidate, candidateAfter)
      && equal(result?.inventoryDifferencesAfter, []), 'The candidate changed during execution.');
    check(result?.inputUnchanged === true && result.preflightAfter?.ready === true && inputAfter?.ready === true
      && inputDigest(inputAfter) === inputAfter.entriesSha256 && input?.entriesSha256 === inputAfter.entriesSha256
      && result.inputEntriesSha256After === inputAfter.entriesSha256, 'Protected inputs changed during execution.');
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
    inputEntriesSha256: input?.entriesSha256 ?? null, counts: result?.counts ?? null };
}

function sameFrozenInputs(frozen, round) {
  return frozen.candidateHead === round.candidateHead && frozen.candidateEntriesSha256 === round.candidateEntriesSha256
    && frozen.inputEntriesSha256 === round.inputEntriesSha256;
}

function pairResult(scope, frozen, rounds, errors) {
  const verified = errors.length === 0 && frozen?.verified === true && rounds.length === 2
    && rounds.every(round => round.verified && sameFrozenInputs(frozen, round));
  return { schemaVersion: 1, mode: 'release-pair', acceptanceScope: 'Two independent strict full runs on one platform using the same frozen candidate and protected inputs.',
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
      const preflightOutput = path.join(output, 'release-pair-preflight');
      log('Freezing shared candidate and protected inputs without executing tests.');
      const execution = await execute(preflightOutput, { preflightOnly: true });
      frozen = { execution, ...await inspectReleaseEvidence(preflightOutput, scope, expectedHead, { preflightOnly: true, execution }) };
      await save(path.join(output, 'release-pair-frozen.json'), frozen);
      if (!frozen.verified) errors.push('Shared full preflight is incomplete.');
      for (let index = 1; index <= 2 && !errors.length; index++) {
        const strictOutput = path.join(output, `strict-full-${index}`);
        log(`Starting independent strict full run ${index}/2 with the frozen inputs.`);
        const execution = await execute(strictOutput, { preflightOnly: false });
        const round = await inspectReleaseEvidence(strictOutput, scope, expectedHead, { execution });
        rounds.push({ index, execution, ...round });
        if (!round.verified) errors.push(`Strict full run ${index} is incomplete or failed.`);
        if (!sameFrozenInputs(frozen, round)) errors.push(`Strict full run ${index} changed the frozen candidate or protected inputs.`);
      }
    }
  } catch (error) { errors.push(`Pair execution stopped: ${error.code ?? error.name}`); }
  const result = pairResult(scope, frozen, rounds, errors);
  await save(path.join(output, 'release-pair.json'), result);
  return result;
}

export async function verifyReleasePair(output, scope, expectedHead) {
  const errors = scopeErrors(scope), rounds = [];
  const frozen = await inspectReleaseEvidence(path.join(output, 'release-pair-preflight'), scope, expectedHead, { preflightOnly: true });
  for (let index = 1; index <= 2; index++) {
    rounds.push({ index, ...await inspectReleaseEvidence(path.join(output, `strict-full-${index}`), scope, expectedHead) });
  }
  if (!frozen.verified) errors.push('Shared preflight evidence is incomplete.');
  for (const round of rounds) {
    if (!round.verified) errors.push(`Strict full run ${round.index} evidence is incomplete.`);
    if (!sameFrozenInputs(frozen, round)) errors.push(`Strict full run ${round.index} differs from the frozen inputs.`);
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

export async function aggregateReleasePairs({ artifacts, expectedHead, runId, attempt, validationResult }) {
  const errors = [], platforms = [];
  const expected = ['ubuntu-24.04', 'windows-2025', 'macos-15'];
  let names = [];
  try { names = await readdir(artifacts); }
  catch (error) { errors.push(`The artifact directory is unavailable (${error.code ?? error.name}).`); }
  if (!/^[a-f0-9]{40}$/u.test(expectedHead ?? '') || !/^[1-9]\d*$/u.test(String(runId)) || !/^[1-9]\d*$/u.test(String(attempt))) errors.push('The exact workflow candidate, run and attempt are required.');
  const expectedNames = expected.map(os => `validation-${os}-shard-1-${attempt}`);
  if (!equal(sorted(names), sorted(expectedNames))) errors.push('Exactly the three current-attempt platform artifacts are required.');
  if (validationResult !== 'success') errors.push('The platform validation jobs did not all succeed.');
  for (const [index, os] of expected.entries()) {
    try {
      const artifact = path.join(artifacts, `validation-${os}-shard-1-${attempt}`);
      const ciRoots = (await readdir(artifact)).filter(name => name.startsWith('ci-'));
      if (ciRoots.length !== 1) throw new Error('AmbiguousEvidence');
      const output = path.join(artifact, ciRoots[0]);
      const scope = JSON.parse(await readFile(path.join(output, 'scope.json'), 'utf8'));
      const result = await verifyReleasePair(output, scope, expectedHead);
      const environment = JSON.parse(await readFile(path.join(artifact, 'environment.json'), 'utf8'));
      const audit = JSON.parse(await readFile(path.join(artifact, 'postgres-audit.json'), 'utf8'));
      const platform = ['linux', 'win32', 'darwin'][index];
      if (scope.platform !== platform || environment.runner?.platform !== platform || environment.runner.commit !== expectedHead
        || String(environment.runner.runId) !== String(runId) || String(environment.runner.attempt) !== String(attempt)) errors.push(`${os}: runner identity differs from the current workflow.`);
      if (audit.clean !== true || audit.connections?.length !== 0 || audit.leakedSchemas?.length !== 0 || audit.leakedRoles?.length !== 0
        || !equal(audit.schemas, environment.schemas) || !equal(audit.roles, environment.roles)
        || audit.database?.started_at !== environment.database?.started_at) errors.push(`${os}: PostgreSQL cleanup or identity is incomplete.`);
      if (!result.strictPairAcceptance) errors.push(`${os}: two strict full runs did not verify.`);
      platforms.push({ artifact: path.basename(artifact), ...result });
    } catch (error) { errors.push(`${os}: evidence unavailable (${error.code ?? error.name}).`); }
  }
  if (platforms.length === 3 && !platforms.every(item => item.selectionSha256 === platforms[0].selectionSha256)) errors.push('The discovered full test sets differ across platforms.');
  return { schemaVersion: 1, mode: 'release-pair', acceptanceScope: 'Two strict full runs per platform, with the same frozen candidate and protected inputs within each Windows/Linux/macOS runner.',
    headSha: expectedHead, runId, attempt, outcome: errors.length ? 'incomplete' : 'passed',
    strictPairAcceptance: errors.length === 0 && platforms.length === 3, releaseAcceptance: false,
    phaseAcceptance: false, productAcceptance: false, productionScaleAcceptance: false,
    unmetPrerequisites, platforms, errors };
}
