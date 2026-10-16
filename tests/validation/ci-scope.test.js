import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyInputIdentity, classify, restrictToRequested, skipGuards } from '../../tools/ci/scope.js';
import { captureInputIdentity } from '../../tools/validation/inputs.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

const ownPath = 'tests/validation/ci-scope.test.js';
const otherPath = 'tests/core/password.test.js';
const unrelatedPath = 'tests/core/composite-format.test.js';
const entry = (filename, overrides = {}) => ({ path: filename, test: true, imports: [], importedFiles: [],
  services: [], tools: [], declaredReferences: [], fixtureReferences: [], conditionalRegistration: false,
  unresolvedImports: [], unresolvedExecutables: [], ...overrides });
const relative = filename => path.relative(repositoryRoot, filename).replaceAll('\\', '/');
const description = filename => ({ filename, available: true, kind: 'file' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('CI statically resolves platform and provisioned-service guards without executing unknown probes', () => {
  const source = `
    const postgres = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const windowsOnly = { skip: process.platform !== 'win32' };
    const service = { skip: !postgres };
    const unknownProbe = { skip: probeAvailability() };
    const knownConjunction = { skip: unknownCondition && !postgres };
  `;
  for (const platform of ['win32', 'linux', 'darwin']) {
    const guards = skipGuards(source, { MEDIAMANAGER_TEST_POSTGRES: '<provisioned>' }, platform);
    assert.deepEqual(guards.map(guard => guard.status), [platform === 'win32' ? 'runs' : 'skips',
      'runs', 'runtime-check', 'runs']);
  }
});

test('CI selection retains provisioned dependencies when the current environment has no executable or service', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, {
    services: ['postgres', 'dotnet'], tools: ['dotnet', 'ffmpeg', 'ffprobe', 'git'],
  })] }, tracked: new Set([ownPath]), environment: {} });
  assert.equal(classification.records[0].selected, true);
  const errors = applyInputIdentity(classification, { entries: [{ filename: path.join(repositoryRoot, 'node_modules'),
    required: true, available: false, reasons: ['runtime:node-modules'] }] }, new Set());
  assert.deepEqual(errors.map(error => error.code), ['input-unavailable']);
  assert.equal(classification.records[0].selected, true, 'a provisioning failure must fail the attempt without narrowing its selection');
});

test('CI excludes only consumers of an explicitly unprovisioned service', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  assert.deepEqual(classification.records.map(record => [record.path, record.selected]), [[ownPath, false], [otherPath, true]]);
  assert.equal(classification.records[0].reasons[0].code, 'service-not-provisioned');
});

test('CI attributes a recursive required input to every actual consumer without excluding sibling fixtures', async t => {
  const output = path.join(repositoryRoot, '.test-output');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'ci-scope-'));
  t.after(async () => {
    assert.ok(root.startsWith(output + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const child = path.join(root, 'shared'), sibling = path.join(root, 'unrelated');
  await mkdir(child); await mkdir(sibling);
  const missing = path.join(root, 'unavailable-native.dll');
  const recursive = path.join(child, 'recursive.json');
  const recursiveBytes = JSON.stringify({ dependency: { filename: missing, sha256: '0'.repeat(64), required: true } });
  await writeFile(recursive, recursiveBytes);
  const manifest = path.join(root, 'provenance.json');
  await writeFile(manifest, JSON.stringify({ dependency: { filename: recursive, sha256: digest(recursiveBytes), required: true } }));
  const independent = path.join(sibling, 'native.json');
  await writeFile(independent, '{}');
  const dependencies = { entries: [entry(ownPath, { fixtureReferences: [description(manifest)] }),
    entry(otherPath, { fixtureReferences: [description(recursive)] }),
    entry(unrelatedPath, { fixtureReferences: [description(independent)] })] };
  const selected = dependencies.entries.map(value => value.path);
  const tracked = new Set([...selected, ...[manifest, recursive, independent].map(relative)]);
  const classification = await classify({ dependencies, tracked, environment: {} });
  assert.ok(classification.records.every(record => record.selected));
  const identity = await captureInputIdentity({ dependencies, selected, environment: {},
    preflight: { ready: true, services: [], tools: [] } });
  const absent = identity.entries.find(input => input.filename === missing);
  assert.ok(absent?.required);
  for (const consumer of [ownPath, otherPath]) {
    assert.ok(absent.reasons.some(reason => reason.startsWith(consumer + ':')), `recursive ownership retained for ${consumer}`);
  }
  assert.ok(!absent.reasons.some(reason => reason.startsWith(unrelatedPath + ':')));
  assert.deepEqual(applyInputIdentity(classification, { entries: [absent] }, tracked), []);
  assert.deepEqual(classification.records.map(record => record.selected), [false, false, true]);
});

test('CI refuses a required digest mismatch without removing the failing consumer from the frozen scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'tests', 'fixtures', 'recording.json');
  const errors = applyInputIdentity(classification, { entries: [{ filename, kind: 'file', available: true,
    required: true, expectedDigestMatched: false, reasons: [ownPath + ':manifest-reference:recording'] }] },
  new Set(['tests/fixtures/recording.json']));
  assert.deepEqual(errors.map(error => error.code), ['input-digest-mismatch']);
  assert.ok(classification.records.every(record => record.selected));
  const malformed = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, invalidExpectedDigest: true, reasons: [ownPath + ':manifest-reference:recording'] }] }, new Set());
  assert.deepEqual(malformed.map(error => error.code), ['input-digest-mismatch'], 'a malformed required pin cannot become an unavailable-input exclusion');
  assert.ok(classification.records.every(record => record.selected));
});

test('CI retains optional historical provenance and fails an unattributed required input', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath)] }, tracked: new Set([ownPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'unavailable-history.json');
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: false, reasons: [ownPath + ':historical-provenance'] }] }, new Set()), []);
  const errors = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, reasons: ['unknown-consumer:manifest-reference'] }] }, new Set());
  assert.deepEqual(errors.map(error => error.code), ['unattributed-input-failure']);
  assert.equal(classification.records[0].selected, true);
});

test('manual CI selection accepts exact comma and newline paths while an empty request preserves automatic scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath), entry(unrelatedPath)] },
    tracked: new Set([ownPath, otherPath, unrelatedPath]), environment: {} });
  const before = structuredClone(classification.records);
  assert.deepEqual(restrictToRequested(classification, ' \r\n, '), { requested: [], infrastructureErrors: [] });
  assert.deepEqual(classification.records, before);
  assert.deepEqual(restrictToRequested(classification, ` ${ownPath},\r\n ${otherPath} `), {
    requested: [ownPath, otherPath], infrastructureErrors: [],
  });
  assert.deepEqual(classification.records.map(record => record.selected), [true, true, false]);
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-requested' }]);
});

test('manual CI selection rejects duplicate, unknown and wildcard paths before changing scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  const before = structuredClone(classification.records);
  for (const raw of [`${ownPath}, ${ownPath}`, `${ownPath}\ntests/unknown.test.js`, 'tests/core/*.test.js', otherPath.replaceAll('/', '\\')]) {
    assert.throws(() => restrictToRequested(classification, raw), /(?:Duplicate|Unknown) requested test:/u);
    assert.deepEqual(classification.records, before);
  }
});

test('manual CI requests fail explicitly when declared or recursively discovered dependencies are unavailable', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath), entry(unrelatedPath)] },
    tracked: new Set([ownPath, otherPath, unrelatedPath]), environment: {} });
  const raw = `${ownPath}\n${otherPath}`;
  const initial = restrictToRequested(classification, raw);
  assert.deepEqual(initial.infrastructureErrors.map(error => [error.code, error.filename]), [['requested-test-unavailable', ownPath]]);
  assert.equal(initial.infrastructureErrors[0].reasons[0].code, 'service-not-provisioned');
  applyInputIdentity(classification, { entries: [{ filename: path.join(repositoryRoot, 'missing-native-input.json'),
    required: true, available: false, reasons: [otherPath + ':manifest-reference:native-input'] }] }, new Set());
  const final = restrictToRequested(classification, raw);
  assert.deepEqual(final.requested, [ownPath, otherPath]);
  assert.deepEqual(final.infrastructureErrors.map(error => error.filename), [ownPath, otherPath]);
  assert.equal(final.infrastructureErrors[1].reasons[0].code, 'input-unavailable');
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-requested' }]);
});
