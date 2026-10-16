import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyInputIdentity, classify, provisionedServicesFor, restrictToRequested, skipGuards } from '../../tools/ci/scope.js';
import { captureInputIdentity, inputsUnchanged } from '../../tools/validation/inputs.js';
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
    required: true, available: false, reasons: ['runtime:node-modules'], requiredReasons: ['runtime:node-modules'] }] }, new Set());
  assert.deepEqual(errors.map(error => error.code), ['input-unavailable']);
  assert.equal(classification.records[0].selected, true, 'a provisioning failure must fail the attempt without narrowing its selection');
});

test('CI excludes only consumers of an explicitly unprovisioned service', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  assert.deepEqual(classification.records.map(record => [record.path, record.selected]), [[ownPath, false], [otherPath, true]]);
  assert.equal(classification.records[0].reasons[0].code, 'service-not-provisioned');
});

test('CI native reference provisioning is an explicit promise independent of runtime file availability', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] };
  const tracked = new Set([ownPath, otherPath]);
  const disabled = await classify({ dependencies, tracked, environment: { MEDIAMANAGER_JELLYFIN_DLL: '/unverified/jellyfin.dll' } });
  assert.equal(disabled.records[0].selected, false, 'a DLL path alone must not enable the native service');
  assert.deepEqual(provisionedServicesFor({ MEDIAMANAGER_CI_NATIVE_REFERENCE: 'false' }), ['postgres', 'dotnet']);
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true' };
  const promised = await classify({ dependencies, tracked, environment });
  assert.ok(promised.records.every(record => record.selected), 'missing provisioning must not narrow selection');
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'jellyfinDll']);
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires its build root and Jellyfin DLL path/u);
  assert.equal(promised.records[0].selected, true);
});

test('CI binds same-run native receipts, source offer and runtime only for selected native consumers', async t => {
  const output = path.join(repositoryRoot, '.test-output'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'ci-native-inputs-'));
  t.after(async () => { assert.ok(root.startsWith(output + path.sep)); await rm(root, { recursive: true, force: true }); });
  for (const directory of ['runtime', 'receipts', 'source-offer']) await mkdir(path.join(root, directory));
  const write = async (directory, filename, bytes) => {
    await writeFile(path.join(root, directory, filename), bytes);
    return { path: filename, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const runtimeFiles = [await write('runtime', 'jellyfin.dll', 'new same-run assembly'),
    await write('runtime', 'MediaBrowser.Providers.dll', 'new same-run dependency')];
  const runtimeManifest = await write('receipts', 'runtime-manifest.json', JSON.stringify({ files: runtimeFiles }));
  const sourceBefore = await write('receipts', 'source-before.json', '{"allMatched":true}');
  const sourceAfter = await write('receipts', 'source-after.json', '{"allMatched":true}');
  const nugetManifest = await write('receipts', 'nuget-manifest.json', '{"packages":[]}');
  await write('receipts', 'build.stdout.txt', 'successful build log');
  const sourceOffer = [];
  for (const filename of ['source.zip', 'source-manifest.json', 'local-modifications.json', 'LICENSE.txt']) {
    sourceOffer.push(await write('source-offer', filename, 'controlled source evidence: ' + filename));
  }
  const receipt = { schemaVersion: 1, status: 'succeeded', sdkActual: '10.0.401', sourceUnchanged: true,
    sourceBefore, sourceAfter, nugetManifest, runtimeManifest, sourceOffer };
  await write('receipts', 'build-receipt.json', JSON.stringify(receipt));
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_NATIVE_BUILD_ROOT: root,
    MEDIAMANAGER_JELLYFIN_DLL: path.join(root, 'runtime/jellyfin.dll') };
  const dependencies = { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] };
  const capture = (selected, overrides = {}) => captureInputIdentity({ dependencies, selected, environment: { ...environment, ...overrides },
    preflight: { ready: true, services: [], tools: [] } });
  const nativeInputs = identity => identity.entries.filter(input => input.requiredReasons.some(reason => reason.startsWith('runtime:native-reference')));
  assert.equal(nativeInputs(await capture([otherPath])).length, 0, 'unselected native consumers do not require native artifacts');
  const classification = await classify({ dependencies, tracked: new Set([ownPath, otherPath]), environment });
  const before = await capture([ownPath]), bound = nativeInputs(before);
  assert.ok(bound.every(input => input.required && input.available && input.expectedDigestMatched !== false));
  for (const directory of ['runtime', 'receipts', 'source-offer']) {
    assert.ok(bound.some(input => input.filename === path.join(root, directory) && input.kind === 'directory'));
  }
  assert.deepEqual(applyInputIdentity(classification, { entries: bound }, new Set()), [], 'same-run build inputs need no Git tracked-file exemption');
  await write('runtime', 'MediaBrowser.Providers.dll', 'changed runtime dependency');
  await write('receipts', 'build.stdout.txt', 'changed build log');
  await write('source-offer', 'source.zip', 'changed source offer');
  const changed = await capture([ownPath]);
  assert.equal(inputsUnchanged(before, changed), false);
  for (const directory of ['runtime', 'receipts', 'source-offer']) {
    const filename = path.join(root, directory);
    assert.notEqual(changed.entries.find(input => input.filename === filename).entriesSha256,
      before.entries.find(input => input.filename === filename).entriesSha256);
  }
  assert.ok(applyInputIdentity(classification, { entries: nativeInputs(changed) }, new Set()).some(error => error.code === 'input-digest-mismatch'));
  assert.equal(classification.records[0].selected, true, 'corrupt build inputs fail the attempt without removing their consumer');
  await rm(path.join(root, 'receipts/build-receipt.json'));
  const missing = await capture([ownPath]);
  assert.ok(applyInputIdentity(classification, { entries: nativeInputs(missing) }, new Set()).some(error => error.code === 'input-unavailable'));
  assert.equal(classification.records[0].selected, true);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt, sourceUnchanged: false }));
  await assert.rejects(capture([ownPath]), /unchanged sealed sources/u);
  await assert.rejects(capture([ownPath], { MEDIAMANAGER_JELLYFIN_DLL: path.join(root, 'unverified.dll') }), /same-run build runtime directory/u);
});

test('CI attributes a recursive required input to every required consumer while preserving an optional consumer of that same file', async t => {
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
  await writeFile(independent, JSON.stringify({ dependency: { filename: missing, sha256: '0'.repeat(64), required: false } }));
  const dependencies = { entries: [entry(ownPath, { fixtureReferences: [description(manifest)] }),
    entry(otherPath, { fixtureReferences: [description(recursive)] }),
    entry(unrelatedPath, { fixtureReferences: [description(independent)] })] };
  const selected = dependencies.entries.map(value => value.path);
  const tracked = new Set([...selected, ...[manifest, recursive, independent].map(relative)]);
  const classification = await classify({ dependencies, tracked, environment: {} });
  assert.ok(classification.records.every(record => record.selected));
  const identity = await captureInputIdentity({ dependencies, selected, environment: {},
    preflight: { ready: true, services: [], tools: [] } });
  assert.equal(identity.schemaVersion, 2);
  const absent = identity.entries.find(input => input.filename === missing);
  assert.ok(absent?.required);
  for (const consumer of [ownPath, otherPath]) {
    assert.ok(absent.requiredReasons.some(reason => reason.startsWith(consumer + ':')), `recursive required ownership retained for ${consumer}`);
  }
  assert.ok(absent.reasons.some(reason => reason.startsWith(unrelatedPath + ':')), 'optional history remains in the input audit');
  assert.ok(!absent.requiredReasons.some(reason => reason.startsWith(unrelatedPath + ':')), 'an unrelated requirement must not promote optional ownership');
  assert.deepEqual(applyInputIdentity(classification, { entries: [absent] }, tracked), []);
  assert.deepEqual(classification.records.map(record => record.selected), [false, false, true]);
});

test('CI refuses a required digest mismatch without removing the failing consumer from the frozen scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'tests', 'fixtures', 'recording.json');
  const errors = applyInputIdentity(classification, { entries: [{ filename, kind: 'file', available: true,
    required: true, expectedDigestMatched: false, reasons: [ownPath + ':manifest-reference:recording'],
    requiredReasons: [ownPath + ':manifest-reference:recording'] }] },
  new Set(['tests/fixtures/recording.json']));
  assert.deepEqual(errors.map(error => error.code), ['input-digest-mismatch']);
  assert.ok(classification.records.every(record => record.selected));
  const malformed = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, invalidExpectedDigest: true, reasons: [ownPath + ':manifest-reference:recording'],
    requiredReasons: [ownPath + ':manifest-reference:recording'] }] }, new Set());
  assert.deepEqual(malformed.map(error => error.code), ['input-digest-mismatch'], 'a malformed required pin cannot become an unavailable-input exclusion');
  assert.ok(classification.records.every(record => record.selected));
});

test('CI treats unprovided external historical paths as not shipped regardless of incidental runner bytes', async () => {
  const filename = path.resolve(repositoryRoot, '..', 'unprovided-historical-tools', 'node.exe');
  const owner = ownPath + ':manifest-reference:' + filename, optional = otherPath + ':manifest-reference:' + filename;
  for (const state of [
    { available: true, expectedDigestMatched: false },
    { available: false, expectedDigestMatched: false },
    { available: true, expectedDigestMatched: true },
  ]) {
    const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
      tracked: new Set([ownPath, otherPath]), environment: {} });
    const input = { filename, kind: 'file', required: true, reasons: [owner, optional], requiredReasons: [owner], ...state };
    assert.deepEqual(applyInputIdentity(classification, { entries: [input] }, new Set()), []);
    assert.equal(classification.records[0].selected, false);
    assert.deepEqual(classification.records[0].reasons, [{ code: 'input-not-shipped', filename, reasons: [owner] }]);
    assert.equal(classification.records[1].selected, true, 'an optional historical observer does not own this requirement');
  }
});

test('CI keeps explicit external runtime, service and tool provisioning failures fatal', async () => {
  const filename = path.resolve(repositoryRoot, '..', 'supplied-runtime', 'runtime.bin');
  for (const supplied of ['runtime:node', 'runtime:native-reference', 'service:jellyfinDll', 'tool:ffmpeg']) {
    for (const state of [
      { available: true, expectedDigestMatched: false },
      { available: false },
    ]) {
      const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
        tracked: new Set([ownPath, otherPath]), environment: {} });
      const reasons = [ownPath + ':manifest-reference:' + filename, supplied];
      const errors = applyInputIdentity(classification, { entries: [{ filename, kind: 'file', required: true,
        reasons, requiredReasons: reasons, ...state }] }, new Set());
      assert.deepEqual(errors, [{ code: state.available ? 'input-digest-mismatch' : 'input-unavailable', filename, reasons }]);
      assert.ok(classification.records.every(record => record.selected), 'explicit supplied input failures cannot shrink scope');
    }
  }
  const classification = await classify({ dependencies: { entries: [entry(ownPath)] }, tracked: new Set([ownPath]), environment: {} });
  const reasons = [ownPath + ':manifest-reference:' + filename];
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, required: true, available: false,
    invalidExpectedDigest: true, reasons, requiredReasons: reasons }] }, new Set()),
  [{ code: 'input-digest-mismatch', filename, reasons }], 'an invalid pin remains a declaration error even for unprovided history');
  assert.equal(classification.records[0].selected, true);
});

test('an exact request still fails when its only required historical input is not shipped', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  restrictToRequested(classification, ownPath);
  const filename = path.resolve(repositoryRoot, '..', 'unprovided-historical-tools', 'ffprobe.exe');
  const reasons = [ownPath + ':manifest-reference:' + filename];
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, kind: 'file', required: true, available: true,
    expectedDigestMatched: false, reasons, requiredReasons: reasons }] }, new Set()), []);
  const request = restrictToRequested(classification, ownPath);
  assert.deepEqual(request.infrastructureErrors.map(error => [error.code, error.filename]), [['requested-test-unavailable', ownPath]]);
  assert.equal(request.infrastructureErrors[0].reasons[0].code, 'input-not-shipped');
  assert.deepEqual(classification.records[1].reasons, [{ code: 'not-requested' }]);
});

test('CI retains optional historical provenance and fails an unattributed required input', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath)] }, tracked: new Set([ownPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'unavailable-history.json');
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: false, reasons: [ownPath + ':historical-provenance'], requiredReasons: [] }] }, new Set()), []);
  const errors = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, reasons: ['unknown-consumer:manifest-reference'], requiredReasons: ['unknown-consumer:manifest-reference'] }] }, new Set());
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
    required: true, available: false, reasons: [otherPath + ':manifest-reference:native-input'],
    requiredReasons: [otherPath + ':manifest-reference:native-input'] }] }, new Set());
  const final = restrictToRequested(classification, raw);
  assert.deepEqual(final.requested, [ownPath, otherPath]);
  assert.deepEqual(final.infrastructureErrors.map(error => error.filename), [ownPath, otherPath]);
  assert.equal(final.infrastructureErrors[1].reasons[0].code, 'input-unavailable');
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-requested' }]);
});
