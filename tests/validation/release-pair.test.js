import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ciExecutionArguments, ciProfile } from '../../tools/ci/scope.js';
import { aggregateReleasePairs, releasePairEnabled, runReleasePair, validateReleasePairEnvironment, verifyReleasePair } from '../../tools/ci/release-pair.js';
import { actualRunnerResult, capturedRunnerProvenance, capturedRunnerShape, fixtureHash, fixtureHead, fixtureScope, saveFixture, writePlatformFixture, writeRunnerFixture } from './release-pair-fixture.js';
import { currentInputDigest } from '../../tools/validation/input-receipt.js';

const workspace = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-release-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const releaseEnvironment = overrides => ({ MEDIAMANAGER_CI_RELEASE_PAIR: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  MEDIAMANAGER_CI_PLATFORM: 'all', GITHUB_SHA: fixtureHead, MEDIAMANAGER_CI_SHARD: '1', MEDIAMANAGER_CI_SHARDS: '1', ...overrides });

test('receipt fixtures bind actual Actions runner bytes and cannot promote a successful available run into full acceptance', async t => {
  for (const [name, bytes] of Object.entries(capturedRunnerShape.raw)) {
    assert.equal(fixtureHash(bytes), capturedRunnerProvenance.sourceFiles[name].sha256);
    assert.equal(Buffer.byteLength(bytes), capturedRunnerProvenance.sourceFiles[name].bytes);
  }
  assert.equal(actualRunnerResult.profile, 'base');
  assert.equal(actualRunnerResult.counts.tests, 2234);
  assert.equal(actualRunnerResult.selected.length, 118);
  assert.equal(actualRunnerResult.outcome, 'passed');
  assert.deepEqual(capturedRunnerShape.inputShape.identityKeys, ['entries', 'services', 'tools', 'systemFonts', 'preflightReady', 'ready']);
  const output = await workspace(t), scope = fixtureScope('darwin');
  const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: (directory, options) =>
    writeRunnerFixture(directory, scope, { ...options, change: files => { files['result.json'] = structuredClone(actualRunnerResult); } }) });
  assert.equal(result.strictPairAcceptance, false);
  assert.equal(result.rounds.length, 0);
});

test('release pairs force full while preserving default available and ordinary full execution', () => {
  assert.equal(releasePairEnabled({}), false);
  assert.equal(ciProfile({}), 'available');
  assert.equal(ciProfile({ MEDIAMANAGER_CI_PROFILE: 'full' }), 'full');
  assert.equal(ciProfile(releaseEnvironment({ MEDIAMANAGER_CI_PROFILE: 'available' })), 'full');
  validateReleasePairEnvironment(releaseEnvironment());
  const scope = fixtureScope();
  assert.deepEqual(ciExecutionArguments(scope, 'output'), ['--output', 'output', '--concurrency', '1', '--profile', 'full']);
  assert.throws(() => ciExecutionArguments({ ...scope, profile: 'ci-available' }, 'output'), /unsharded full/u);
  assert.throws(() => ciProfile(releaseEnvironment({ MEDIAMANAGER_CI_TEST_FILES: 'tests/one.test.js' })), /explicit test subset/u);
  for (const overrides of [{ GITHUB_EVENT_NAME: 'push' }, { MEDIAMANAGER_CI_PLATFORM: 'windows' },
    { MEDIAMANAGER_CI_SHARD: '2' }, { MEDIAMANAGER_CI_SHARDS: '4' }, { GITHUB_SHA: 'unknown' },
    { MEDIAMANAGER_CI_TEST_FILES: 'tests/one.test.js' }, { MEDIAMANAGER_CI_RELEASE_PAIR: 'yes' }]) {
    assert.throws(() => validateReleasePairEnvironment(releaseEnvironment(overrides)));
  }
});

test('one frozen preflight and two fresh full outputs use the same inputs and preserve both original TAP files', async t => {
  const output = await workspace(t), scope = fixtureScope(), calls = [];
  const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: async (directory, options) => {
    calls.push([path.basename(directory), options.preflightOnly]);
    const archiveRevision = calls.length;
    return writeRunnerFixture(directory, scope, { ...options, change: files => {
      for (const name of ['inputs-before.json', 'inputs-after.json']) if (files[name]) {
        files[name].historicalArchiveComplete = archiveRevision % 2 === 0;
        files[name].historicalArchive = { ...files[name].historicalArchive, auditStatus: `diagnostic-${archiveRevision}-${name}` };
      }
      const resultReceipt = files['result.json'];
      resultReceipt.historicalArchiveComplete = archiveRevision % 2 !== 0;
      resultReceipt.historicalArchive = { auditStatus: `result-diagnostic-${archiveRevision}-before` };
      if (Object.hasOwn(resultReceipt, 'historicalArchiveCompleteAfter')) {
        resultReceipt.historicalArchiveCompleteAfter = archiveRevision % 2 === 0;
        resultReceipt.historicalArchiveAfter = { auditStatus: `result-diagnostic-${archiveRevision}-after` };
      }
    } });
  } });
  assert.equal(result.strictPairAcceptance, true);
  assert.equal(result.releaseAcceptance, false);
  assert.equal(result.productAcceptance, false);
  assert.equal(result.productionScaleAcceptance, false);
  assert.deepEqual(calls, [['release-pair-preflight', true], ['strict-full-1', false], ['strict-full-2', false]]);
  assert.equal(result.rounds[0].currentInputEntriesSha256, result.rounds[1].currentInputEntriesSha256);
  assert.equal(result.rounds[0].candidateEntriesSha256, result.frozen.candidateEntriesSha256);
  for (const index of [1, 2]) {
    assert.match(await readFile(path.join(output, `strict-full-${index}`, 'test.tap'), 'utf8'), /# pass 2/u);
    const receipt = JSON.parse(await readFile(path.join(output, `strict-full-${index}`, 'result.json'), 'utf8'));
    for (const oldName of ['inputEntriesSha256', 'inputEntriesSha256After', 'inputUnchanged']) {
      assert.equal(Object.hasOwn(receipt, oldName), false, `schema-3 synthetic result excludes ${oldName}`);
    }
  }
  assert.equal((await verifyReleasePair(output, scope, fixtureHead)).strictPairAcceptance, true);
});

test('schema-2 protected input receipts are rejected without a compatibility path', async t => {
  const output = await workspace(t), scope = fixtureScope(), calls = [];
  const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: async (directory, options) => {
    calls.push(options.preflightOnly);
    return writeRunnerFixture(directory, scope, { ...options,
      change: files => { files['inputs-before.json'].schemaVersion = 2; } });
  } });
  assert.deepEqual(calls, [true]);
  assert.equal(result.strictPairAcceptance, false);
  assert.equal(result.executed, false);
  assert.deepEqual(result.rounds, []);
  assert.equal(result.frozen.verified, false);
  assert.match(result.frozen.errors.join('\n'), /current release input identity is invalid/u);
});

test('missing shared full inputs stop before either execution without reducing the full scope', async t => {
  const output = await workspace(t), scope = fixtureScope(), calls = [];
  const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: async (directory, options) => {
    calls.push(options.preflightOnly);
    return writeRunnerFixture(directory, scope, { ...options, change: files => {
      const input = files['inputs-before.json'], entry = input.entries[0];
      Object.assign(entry, { available: false });
      for (const name of ['kind', 'bytes', 'sha256']) delete entry[name];
      input.currentReleaseInputReady = false;
      input.entriesSha256 = currentInputDigest(input);
      files['result.json'].currentInputEntriesSha256 = input.entriesSha256;
    } });
  } });
  assert.deepEqual(calls, [true]);
  assert.equal(result.strictPairAcceptance, false);
  assert.equal(result.executed, false);
  assert.deepEqual(result.rounds, []);
  assert.equal(scope.selected.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(output, 'release-pair.json'), 'utf8')).strictPairAcceptance, false);
});

test('first-round failures, narrowed scope, missing registration and incomplete TAP cannot start a second round', async t => {
  const changes = [
    files => { files['result.json'].outcome = 'failed'; },
    files => { files['result.json'].profile = 'base'; },
    files => { files['result.json'].selected = files['result.json'].selected.slice(0, 1); },
    files => { files['test-registrations.json'].files[0].registrations = 0; },
    files => { delete files['result.json'].testResources; },
    files => { files['result.json'].testResources = { released: false, remaining: ['occupied'] }; },
    files => { files['test.tap'] = files['test.tap'].replace('# pass 2', '# pass 1').replace('# skipped 0', '# skipped 1'); },
    files => { files['test.tap'] = files['test.tap'].replace('1..2\n', ''); },
    files => { delete files['test.tap']; },
  ];
  for (const [index, change] of changes.entries()) await t.test(`rejection ${index + 1}`, async child => {
    const output = await workspace(child), scope = fixtureScope(), calls = [];
    const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: async (directory, options) => {
      calls.push(options.preflightOnly);
      return writeRunnerFixture(directory, scope, { ...options, ...(!options.preflightOnly ? { change } : {}) });
    } });
    assert.equal(result.strictPairAcceptance, false);
    assert.deepEqual(calls, [true, false]);
    assert.equal(result.rounds.length, 1);
  });
});

test('individually successful second rounds with replaced inputs or changed candidate are rejected against the first frozen identity', async t => {
  for (const replacement of [{ inputText: 'replacement instance' }, { candidateText: 'replacement candidate' }]) await t.test(Object.keys(replacement)[0], async child => {
    const output = await workspace(child), scope = fixtureScope();
    let round = 0;
    const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: (directory, options) => {
      if (!options.preflightOnly) round++;
      return writeRunnerFixture(directory, scope, { ...options, ...(round === 2 ? replacement : {}) });
    } });
    assert.equal(result.rounds[1].verified, true, 'Each isolated full receipt can pass while the pair changes inputs.');
    assert.equal(result.strictPairAcceptance, false);
    assert.match(result.errors.join('\n'), /changed the frozen candidate or protected current release inputs/u);
    assert.equal((await verifyReleasePair(output, scope, fixtureHead)).strictPairAcceptance, false);
  });
});

test('timeout, cancellation, missing receipts and an executor exception preserve an incomplete pair', async t => {
  for (const mode of ['timeout', 'cancelled', 'exception']) await t.test(mode, async child => {
    const output = await workspace(child), scope = fixtureScope();
    const result = await runReleasePair({ scope, output, expectedHead: fixtureHead, execute: async (directory, options) => {
      if (!options.preflightOnly && mode === 'exception') throw new Error('Controlled interruption');
      const execution = await writeRunnerFixture(directory, scope, options);
      return !options.preflightOnly ? { ...execution, timedOut: mode === 'timeout', cancelled: mode === 'cancelled' } : execution;
    } });
    assert.equal(result.strictPairAcceptance, false);
    assert.equal(JSON.parse(await readFile(path.join(output, 'release-pair.json'), 'utf8')).releaseAcceptance, false);
  });
});

test('full subset declarations and shards fail before any executor is invoked', async t => {
  const output = await workspace(t), scope = fixtureScope();
  const result = await runReleasePair({ scope: { ...scope, discovered: [...scope.discovered, 'tests/controlled/omitted.test.js'] },
    output, expectedHead: fixtureHead, execute: () => { throw new Error('Must not execute'); } });
  assert.equal(result.strictPairAcceptance, false);
  assert.equal(result.frozen, null);
});

test('cross-platform aggregation rechecks all raw pairs and requires three-platform cleanup without claiming product acceptance', async t => {
  const artifacts = await workspace(t);
  const paths = [];
  for (const [os, platform] of [['ubuntu-24.04', 'linux'], ['windows-2025', 'win32'], ['macos-15', 'darwin']]) {
    paths.push(await writePlatformFixture(artifacts, os, platform, runReleasePair));
  }
  const options = { artifacts, expectedHead: fixtureHead, runId: '44', attempt: '1', validationResult: 'success' };
  const passed = await aggregateReleasePairs(options);
  assert.equal(passed.strictPairAcceptance, true);
  assert.equal(passed.releaseAcceptance, false);
  assert.equal(passed.platforms.length, 3);
  assert.equal(new Set(passed.platforms.map(item => item.frozen.candidateEntriesSha256)).size, 3, 'Platform checkout bytes can differ while the clean Git head remains the same.');
  assert.equal((await aggregateReleasePairs({ ...options, validationResult: 'failure' })).strictPairAcceptance, false);
  assert.equal((await aggregateReleasePairs({ ...options, attempt: '2' })).strictPairAcceptance, false);
  const audit = path.join(paths[0].artifact, 'postgres-audit.json');
  const originalAudit = JSON.parse(await readFile(audit, 'utf8'));
  await saveFixture(audit, { ...originalAudit, clean: false, connections: [{ pid: 17 }] });
  assert.equal((await aggregateReleasePairs(options)).strictPairAcceptance, false);
  await saveFixture(audit, originalAudit);
  const tap = path.join(paths[1].output, 'strict-full-2/test.tap');
  await writeFile(tap, (await readFile(tap, 'utf8')).replace('# pass 2', '# pass 1'));
  assert.equal((await aggregateReleasePairs(options)).strictPairAcceptance, false, 'A recorded true flag cannot hide altered raw evidence.');
});

test('missing platform artifacts and stale-attempt evidence never aggregate as a complete pair', async t => {
  const artifacts = await workspace(t);
  await writePlatformFixture(artifacts, 'ubuntu-24.04', 'linux', runReleasePair);
  const options = { artifacts, expectedHead: fixtureHead, runId: '44', attempt: '1', validationResult: 'success' };
  const result = await aggregateReleasePairs(options);
  assert.equal(result.strictPairAcceptance, false);
  assert.equal(result.platforms.length, 1);
  assert.match(result.errors.join('\n'), /three current-attempt/u);
  await mkdir(path.join(artifacts, 'validation-ubuntu-24.04-shard-1-2'));
  assert.equal((await aggregateReleasePairs(options)).strictPairAcceptance, false);
});
