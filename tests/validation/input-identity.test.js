import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFile } from '../../tools/validation/inventory.js';
import { captureInputIdentity, inputsUnchanged } from '../../tools/validation/inputs.js';
import { resultOutcome } from '../../tools/validation/run.js';
import { repositoryRoot, validationPath } from '../../tools/validation/paths.js';
import { collageFontFiles } from '../../src/images/font-collection.js';
import { resolveCollageSystemFonts } from '../../src/images/system-fonts/index.js';
import { applyInputIdentity, classify } from '../../tools/ci/scope.js';
// This regression reads the real reader's system-font input. Keep that reader
// in the test dependency closure so strict validation binds the same bytes.
import '../../src/images/user-view-collage.js';

const counts = { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const outcome = inputUnchanged => resultOutcome(0, counts, { candidateUnchanged: true, inputUnchanged, preflightReady: true });

async function temporaryInputs(t) {
  const root = path.resolve(repositoryRoot, '.test-output');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'validation-input-identity-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(root + path.sep), 'cleanup stays inside the controlled ignored output directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const captureService = async (name, filename) => captureInputIdentity({
  selected: [], dependencies: { entries: [] }, environment: {},
  preflight: { ready: true, tools: [], services: [{ name, ...await describeFile(filename) }] },
});

test('shared fixture roots keep nested execution pins with their actual file or directory consumer', async t => {
  const directory = await temporaryInputs(t), used = path.join(directory, 'probe.json');
  const nested = path.join(directory, 'another-fixture'); await mkdir(nested);
  const manifest = path.join(nested, 'provenance.json'), missing = path.join(directory, 'missing-original.bin');
  await writeFile(used, '{}');
  await writeFile(manifest, JSON.stringify({ requiredInputs: [{ filename: missing, sha256: '0'.repeat(64), required: true }] }));
  const consumer = 'tests/shared-fixture-consumer.test.js';
  const entry = overrides => ({ path: consumer, imports: [], test: true, importedFiles: [], services: [], tools: [],
    declaredReferences: [], fixtureReferences: [], ...overrides });
  const capture = overrides => captureInputIdentity({ selected: [consumer], dependencies: { entries: [entry(overrides)] },
    environment: {}, preflight: { ready: true, services: [], tools: [] } });
  const shared = await capture({ fixtureReferences: [{ filename: used }] });
  assert.equal(shared.ready, true);
  assert.equal(shared.entries.some(input => input.filename === missing && input.required), false,
    'a sibling file does not acquire a nested fixture consumer\'s original execution inputs');
  const direct = await capture({ fixtureReferences: [{ filename: manifest }] });
  const tree = await capture({ declaredReferences: [{ filename: directory, required: true, dynamic: false, kind: 'directory', available: true }] });
  for (const identity of [direct, tree]) {
    assert.equal(identity.ready, false);
    const required = identity.entries.find(input => input.filename === missing);
    assert.equal(required.required, true);
    assert.ok(required.requiredReasons.every(reason => reason.startsWith(consumer + ':')));
  }
});

test('the collage source closure requires the exact system collection bytes used for face registration', async () => {
  const filename = 'src/images/user-view-collage.js', consumer = 'tests/validation/input-identity.test.js';
  const entry = (path, imports, test = false) => ({ path, imports, test, importedFiles: [], services: [], tools: [],
    declaredReferences: [], fixtureReferences: [], conditionalRegistration: false, unresolvedImports: [], unresolvedExecutables: [] });
  const dependencies = { entries: [entry(filename, []), entry(consumer, [filename], true)] };
  const capture = selected => captureInputIdentity({ selected, dependencies, environment: {},
    preflight: { ready: true, tools: [], services: [] } });
  const selected = await capture([consumer]), unselected = await capture([]);
  const reason = 'runtime:collage-system-font';
  assert.deepEqual(selected.entries.filter(entry => entry.reasons.includes(reason)).map(entry => entry.filename), collageFontFiles());
  assert.equal(unselected.entries.some(entry => entry.reasons.includes(reason)), false);
  for (const font of collageFontFiles()) {
    const entry = selected.entries.find(entry => entry.filename === font);
    assert.equal(entry.available, true); assert.equal(entry.required, true);
    assert.ok(entry.requiredReasons.includes(reason));
    assert.equal(entry.sha256, createHash('sha256').update(await readFile(font)).digest('hex'));
  }
  const classification = await classify({ dependencies, tracked: new Set([filename, consumer]), environment: {} });
  const fonts = selected.entries.filter(entry => entry.reasons.includes(reason));
  assert.deepEqual(applyInputIdentity(classification, { entries: fonts }, new Set()), [], 'installed fonts are runner inputs, not unshipped historical evidence');
  assert.equal(classification.records[0].selected, true);
  const missing = { filename: collageFontFiles('darwin')[0], required: true, available: false, reasons: [reason], requiredReasons: [reason] };
  assert.deepEqual(applyInputIdentity(classification, { entries: [missing] }, new Set()).map(error => error.code), ['input-unavailable']);
  assert.equal(classification.records[0].selected, true, 'a missing promised system font fails infrastructure without shrinking the selection');
});

test('actual system-font consumers bind selected bytes and configuration without activating unrelated resolver imports', async () => {
  const consumer = 'tests/images/system-fonts-runtime.test.js', resolver = 'src/images/system-fonts/index.js';
  const unrelated = 'tests/images/collage-fonts.test.js';
  const entry = (path, imports, test = false) => ({ path, imports, test, importedFiles: [], services: [], tools: [],
    declaredReferences: [], fixtureReferences: [], conditionalRegistration: false, unresolvedImports: [], unresolvedExecutables: [] });
  const dependencies = { entries: [entry(resolver, []), entry(consumer, [resolver], true), entry(unrelated, [resolver], true)] };
  const capture = selected => captureInputIdentity({ selected, dependencies, environment: {},
    preflight: { ready: true, tools: [], services: [] } });
  const selected = await capture([consumer]), inactive = await capture([unrelated]);
  assert.equal(Object.hasOwn(inactive, 'systemFonts'), false);
  assert.equal(inactive.entries.some(entry => entry.reasons.some(reason => reason.startsWith('runtime:collage-'))), false);
  const resolved = await resolveCollageSystemFonts();
  const { configurationBindings, ...selection } = selected.systemFonts;
  assert.deepEqual(selection, resolved);
  assert.deepEqual(configurationBindings.map(binding => binding.filename), resolved.configurationFiles);
  const configurationFiles = [];
  const verifyConfiguration = async binding => {
    assert.equal(binding.actual, await realpath(binding.filename));
    const logical = await lstat(binding.filename);
    assert.equal(binding.linkTarget, logical.isSymbolicLink() ? await readlink(binding.filename) : undefined);
    if (binding.kind === 'directory') {
      assert.ok((await stat(binding.actual)).isDirectory());
      assert.deepEqual(binding.entries.map(entry => path.basename(entry.filename)), (await readdir(binding.filename)).sort());
      for (const child of binding.entries) await verifyConfiguration(child);
    } else {
      assert.equal(binding.kind, 'file');
      configurationFiles.push(binding.actual);
    }
  };
  for (const binding of configurationBindings) await verifyConfiguration(binding);
  assert.ok(resolved.defaultFace && resolved.files.length > 0, 'the actual runner must provide the default face');
  for (const [names, reason] of [[resolved.files, 'runtime:collage-selected-font'],
    [configurationFiles, 'runtime:collage-font-configuration'], [resolved.libraryFiles ?? [], 'runtime:collage-font-library']]) {
    const entries = selected.entries.filter(entry => entry.reasons.includes(reason));
    assert.deepEqual(entries.map(entry => entry.filename).sort(), [...new Set(await Promise.all(names.map(filename => realpath(filename))))].sort());
    for (const entry of entries) {
      assert.equal(entry.available, true); assert.equal(entry.required, true);
      assert.ok(entry.requiredReasons.includes(reason));
      const actual = await describeFile(entry.filename);
      assert.equal(entry.sha256 ?? entry.entriesSha256, actual.sha256 ?? actual.entriesSha256);
    }
  }
  const classification = await classify({ dependencies, tracked: new Set([consumer, resolver, unrelated]),
    environment: { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true' } });
  const font = selected.entries.find(entry => entry.reasons.includes('runtime:collage-selected-font'));
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ ...font, available: false }] }, new Set()).map(error => error.code),
    ['input-unavailable']);
  assert.equal(classification.records.find(record => record.path === consumer).selected, true,
    'a missing actual system font fails infrastructure instead of shrinking requested scope');
});

async function isolatedDotnet(t) {
  const directory = await temporaryInputs(t), root = path.join(directory, 'mediamanager-dotnet');
  for (const name of ['host/fxr/10.0.4', 'shared/Microsoft.NETCore.App/10.0.4', 'sdk/10.0.401',
    'packs/Microsoft.NETCore.App.Ref/10.0.4/ref/net10.0', 'sdk-manifests/10.0.400']) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'controlled-input.bin'), 'controlled SDK input: ' + name);
  }
  const executable = path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  await writeFile(executable, 'controlled executable identity; never executed');
  const environment = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: directory, DOTNET_INSTALL_DIR: root,
    MEDIAMANAGER_CI_DOTNET_ROOT: root, MEDIAMANAGER_DOTNET: executable };
  return { directory, root, executable, environment };
}

test('CI binds the entire verified dotnet installation, including reference packs, without redirecting historical paths', async t => {
  const { root, executable, environment } = await isolatedDotnet(t);
  const options = { selected: [], dependencies: { entries: [] }, environment,
    preflight: { ready: true, tools: [{ name: 'dotnet', executable, available: true }],
      services: [{ name: 'dotnet', filename: executable, available: true }] } };
  const before = await captureInputIdentity(options), installed = before.entries.find(entry => entry.filename === root);
  assert.equal(before.ready, true);
  assert.equal(installed.kind, 'directory'); assert.equal(installed.required, true); assert.equal(installed.available, true);
  assert.ok(installed.requiredReasons.includes('runtime:dotnet-installation'));
  assert.ok(installed.entries.some(entry => entry.name === 'packs'));
  assert.ok(installed.entries.some(entry => entry.name === 'sdk-manifests'));
  for (const name of ['host', 'shared', 'sdk']) {
    const entry = before.entries.find(entry => entry.filename === path.join(root, name));
    assert.ok(entry.requiredReasons.includes('service:dotnet-' + name));
    assert.ok(entry.requiredReasons.includes('tool:dotnet-' + name));
  }
  const pack = path.join(root, 'packs/Microsoft.NETCore.App.Ref/10.0.4/ref/net10.0/controlled-input.bin');
  await writeFile(pack, 'changed reference assembly while the SDK executable stayed unchanged');
  const after = await captureInputIdentity(options);
  assert.equal(inputsUnchanged(before, after), false);
  assert.equal(outcome(inputsUnchanged(before, after)), 'incomplete');
  assert.notEqual(installed.entriesSha256, after.entries.find(entry => entry.filename === root).entriesSha256);
  assert.equal(validationPath('.tools/dotnet/dotnet.exe', repositoryRoot, environment), path.join(repositoryRoot, '.tools/dotnet/dotnet.exe'),
    'CI installation identity does not remap historical .tools/dotnet paths');
});

test('an isolated dotnet promise fails when verification, execution identity or required SDK inputs are missing', async t => {
  const { directory, root, executable, environment } = await isolatedDotnet(t);
  const selected = ['tests/controlled-dotnet.test.js'];
  const dependencies = { entries: [{ path: selected[0], imports: [], importedFiles: [], services: ['dotnet'], tools: [],
    declaredReferences: [], fixtureReferences: [] }] };
  // Planning has no executable preflight yet; the selected dependency still
  // owns the promised installation and cannot silently fall back to PATH.
  const capture = overrides => captureInputIdentity({ selected, dependencies, environment: { ...environment, ...overrides },
    preflight: { ready: true, tools: [], services: [] } });
  await assert.rejects(capture({ MEDIAMANAGER_CI_DOTNET_ROOT: undefined }), /verified isolated installation/u);
  await assert.rejects(capture({ MEDIAMANAGER_DOTNET: undefined }), /verified isolated installation/u);
  await assert.rejects(capture({ DOTNET_INSTALL_DIR: directory }), /declared isolated runner installation/u);
  const other = path.join(directory, path.basename(executable)); await writeFile(other, 'a different tool installation');
  await assert.rejects(capture({ MEDIAMANAGER_DOTNET: other }), /verified isolated executable/u);
  await assert.rejects(captureInputIdentity({ selected, dependencies, environment,
    preflight: { ready: true, services: [], tools: [{ name: 'dotnet', executable: other, available: true }] } }), /verified isolated executable/u);
  await rm(path.join(root, 'packs'), { recursive: true });
  await assert.rejects(capture({}), { code: 'ENOENT' });
});

test('validation binds workspace package links and rejects unapproved link traversal', async()=>{
  const directory=path.join(repositoryRoot,'node_modules','@mediamanager','plugin-sdk');
  assert.equal((await describeFile(directory)).available,false);
  const bound=await describeFile(directory,{workspaceLinks:true});
  assert.equal(bound.available,true);assert.equal(bound.kind,'workspace-link');
  assert.equal(bound.package.filename,path.join(repositoryRoot,'packages','plugin-sdk'));
  assert.ok(bound.package.entries.some(entry=>entry.name==='package.json'));
});

test('validation recursively binds ignored input contents and membership without relying on timestamps', async t => {
  const directory = await temporaryInputs(t), nested = path.join(directory, 'data', 'nested');
  await mkdir(nested, { recursive: true });
  const filename = path.join(nested, 'jellyfin.db');
  await writeFile(filename, 'original');
  const before = await describeFile(directory, { recursive: true });
  assert.equal(typeof before.entriesSha256, 'string');
  assert.ok(before.entries.length > 0);
  const time = await stat(filename);
  await utimes(filename, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal((await describeFile(directory)).entriesSha256, before.entriesSha256, 'mtime alone does not change content identity');
  await writeFile(filename, 'modified');
  await utimes(filename, time.atime, time.mtime);
  assert.notEqual((await describeFile(directory)).entriesSha256, before.entriesSha256, 'same size and restored mtime cannot hide content changes');
  await writeFile(filename, 'original');
  assert.equal((await describeFile(directory)).entriesSha256, before.entriesSha256);
  const extra = path.join(nested, 'new.json');
  await writeFile(extra, '{}');
  const added = await describeFile(directory);
  assert.notEqual(added.entriesSha256, before.entriesSha256, 'new nested files are part of the identity');
  await rm(extra);
  assert.equal((await describeFile(directory)).entriesSha256, before.entriesSha256);
  await rm(filename);
  assert.notEqual((await describeFile(directory)).entriesSha256, before.entriesSha256, 'removed nested files are part of the identity');
});

test('passing TAP and unchanged candidate cannot hide a changed native instance input', async t => {
  const directory = await temporaryInputs(t), data = path.join(directory, 'data', 'data');
  await mkdir(data, { recursive: true });
  const filename = path.join(data, 'jellyfin.db');
  await writeFile(filename, 'native database before execution');
  const before = await captureService('nativeInstance', directory);
  assert.equal(outcome(inputsUnchanged(before, await captureService('nativeInstance', directory))), 'passed');
  await writeFile(filename, 'native database changed during execution');
  const after = await captureService('nativeInstance', directory);
  assert.equal(inputsUnchanged(before, after), false);
  assert.equal(outcome(inputsUnchanged(before, after)), 'incomplete');
});

test('validation binds the Jellyfin DLL dependency directory as well as the entry assembly', async t => {
  const directory = await temporaryInputs(t), assembly = path.join(directory, 'jellyfin.dll');
  const dependency = path.join(directory, 'MediaBrowser.Providers.dll');
  await writeFile(assembly, 'unchanged main assembly');
  await writeFile(dependency, 'provider implementation before');
  const assemblyBefore = await readFile(assembly), before = await captureService('jellyfinDll', assembly);
  await writeFile(dependency, 'provider implementation after');
  assert.deepEqual(await readFile(assembly), assemblyBefore);
  const after = await captureService('jellyfinDll', assembly);
  assert.equal(inputsUnchanged(before, after), false, 'changing only a runtime dependency invalidates the input identity');
  assert.equal(outcome(inputsUnchanged(before, after)), 'incomplete');
  await rm(dependency);
  assert.equal(outcome(inputsUnchanged(before, await captureService('jellyfinDll', assembly))), 'incomplete');
});

test('validation binds required fixture siblings and detects disappearing declared inputs', async t => {
  const directory = await temporaryInputs(t), manifest = path.join(directory, 'manifest.json');
  const sibling = path.join(directory, 'native.json');
  await writeFile(manifest, JSON.stringify({ native: 'native.json' }));
  await writeFile(sibling, '{"observed":true}');
  const reference = { logicalPath: 'controlled-fixture/manifest.json', required: true, dynamic: false,
    ...await describeFile(manifest) };
  const options = { selected: ['tests/controlled.test.js'],
    dependencies: { entries: [{ path: 'tests/controlled.test.js', declaredReferences: [reference] }] },
    preflight: { ready: true, tools: [], services: [] }, environment: {} };
  const before = await captureInputIdentity(options);
  await writeFile(sibling, '{"observed":false}');
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete', 'dynamic sibling data is bound through its manifest directory');
  await writeFile(sibling, '{"observed":true}');
  assert.equal(inputsUnchanged(before, await captureInputIdentity(options)), true);
  await rm(manifest);
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete');
});

test('validation follows JSON fixture provenance and binds external dynamic input directories', async t => {
  const directory = await temporaryInputs(t), fixtures = path.join(directory, 'fixtures'), external = path.join(directory, 'external');
  await mkdir(fixtures);
  await mkdir(path.join(external, 'artist-probe'), { recursive: true });
  const manifest = path.join(fixtures, 'native.json'), summary = path.join(external, 'artist-probe', 'summary.json');
  await writeFile(manifest, JSON.stringify({ sideEffects: [{ sourceEvidence: '.agent-docs/evidence/artist-probe/native-contract.json' }] }));
  await writeFile(summary, '{"observed":true}');
  const options = { selected: ['tests/controlled.test.js'], dependencies: { entries: [{ path: 'tests/controlled.test.js',
    declaredReferences: [], fixtureReferences: [{ ...await describeFile(manifest) }] }] },
  preflight: { ready: true, tools: [], services: [] }, environment: { MEDIAMANAGER_VALIDATION_INPUT_ROOT: external } };
  const before = await captureInputIdentity(options);
  assert.equal(before.ready, true, 'a provenance-only missing contract is recorded without inventing a mandatory read');
  assert.ok(before.entries.some(entry => entry.filename === path.dirname(summary)));
  await writeFile(summary, '{"observed":false}');
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete');
  await rm(summary);
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete');
});

test('validation binds absolute prepared inputs and source chains without treating DTO media paths as inputs', async t => {
  const directory = await temporaryInputs(t), fixtures = path.join(directory, 'fixtures'), source = path.join(directory, 'source');
  await mkdir(fixtures);
  await mkdir(source);
  const evidence = path.join(directory, 'evidence'), recording = path.join(evidence, 'recording');
  await mkdir(recording, { recursive: true });
  const database = path.join(source, 'initial.db'), script = path.join(source, 'bootstrap.mjs');
  const bootstrap = path.join(source, 'bootstrap.json'), manifest = path.join(fixtures, 'native.json');
  const provenance = path.join(recording, 'provenance.json');
  const mediaPath = path.join(directory, 'unread-media.mkv');
  await writeFile(database, 'native database before');
  await writeFile(script, 'bootstrap implementation before');
  await writeFile(bootstrap, JSON.stringify({ sourceDatabase: database, bootstrapScript: { path: script, sha256: 'a'.repeat(64) } }));
  await writeFile(path.join(recording, 'native-contract.json'), '{"cases":[]}');
  await writeFile(manifest, JSON.stringify({ sourceEvidence: '.agent-docs/evidence/recording/native-contract.json' }));
  await writeFile(provenance, JSON.stringify({ preparedInputs: [{ kind: 'nativeReferencePreparation', path: bootstrap, sha256: 'b'.repeat(64) }],
    items: [{ Path: mediaPath, path: mediaPath }] }));
  const options = { selected: ['tests/controlled.test.js'], dependencies: { entries: [{ path: 'tests/controlled.test.js',
    declaredReferences: [], fixtureReferences: [{ ...await describeFile(manifest) }] }] },
  preflight: { ready: true, tools: [], services: [] }, environment: { MEDIAMANAGER_VALIDATION_INPUT_ROOT: evidence } };
  const before = await captureInputIdentity(options);
  assert.ok(before.entries.some(entry => entry.filename === database));
  assert.ok(before.entries.some(entry => entry.filename === script));
  assert.equal(before.entries.some(entry => entry.filename === mediaPath), false);
  assert.equal(before.ready, true);
  await writeFile(database, 'native database changed');
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete');
  await writeFile(database, 'native database before');
  await writeFile(script, 'bootstrap implementation changed');
  assert.equal(outcome(inputsUnchanged(before, await captureInputIdentity(options))), 'incomplete');
});

test('validation rejects missing or changed required helper inputs before execution', async t => {
  const directory = await temporaryInputs(t), fixtures = path.join(directory, 'fixtures'), helpers = path.join(directory, 'helpers');
  await mkdir(fixtures); await mkdir(helpers);
  const manifest = path.join(fixtures, 'provenance.json'), helper = path.join(helpers, 'Oracle.dll');
  const original = 'pinned native helper', digest = createHash('sha256').update(original).digest('hex');
  await writeFile(manifest, JSON.stringify({ helper: { filename: helper, sha256: digest, required: true },
    historicalSource: { filename: path.join(helpers, 'missing.cs'), sha256: 'a'.repeat(64) } }));
  const options = { selected: ['tests/controlled.test.js'], dependencies: { entries: [{ path: 'tests/controlled.test.js',
    declaredReferences: [], fixtureReferences: [await describeFile(manifest)] }] },
  preflight: { ready: true, tools: [], services: [] }, environment: {} };
  const missing = await captureInputIdentity(options);
  assert.equal(missing.ready, false, 'a dynamic required helper must exist before the runner executes tests');
  assert.equal(missing.entries.find(entry => entry.filename === helper).required, true);
  await writeFile(helper, original);
  const valid = await captureInputIdentity(options);
  assert.equal(valid.ready, true, 'missing historical source descriptions remain optional');
  assert.equal(valid.entries.find(entry => entry.filename === helper).expectedDigestMatched, true);
  await writeFile(helper, 'different native helper');
  const changed = await captureInputIdentity(options), unchanged = await captureInputIdentity(options);
  assert.equal(inputsUnchanged(changed, unchanged), true, 'stable bytes do not prove that the pinned helper was used');
  assert.equal(changed.ready, false);
  assert.equal(changed.entries.find(entry => entry.filename === helper).expectedDigestMatched, false);
  assert.equal(resultOutcome(0, counts, { candidateUnchanged: true, inputUnchanged: true, preflightReady: changed.ready }), 'incomplete');
});

test('validation preserves required pins across duplicate and transitive manifest references', async t => {
  const directory = await temporaryInputs(t), fixtures = path.join(directory, 'fixtures'), helpers = path.join(directory, 'helpers');
  await mkdir(fixtures); await mkdir(helpers);
  const manifest = path.join(fixtures, 'provenance.json'), helperManifest = path.join(helpers, 'helper.json');
  const helper = path.join(helpers, 'Oracle.dll'), original = 'required through a manifest';
  const digest = createHash('sha256').update(original).digest('hex');
  const content = { helper: { filename: helper, sha256: digest, required: true },
    description: { filename: helper, sha256: 'b'.repeat(64), required: false } };
  await writeFile(helper, original); await writeFile(helperManifest, JSON.stringify(content));
  await writeFile(manifest, JSON.stringify({ helperManifest: { filename: helperManifest,
    sha256: createHash('sha256').update(await readFile(helperManifest)).digest('hex'), required: true } }));
  const options = { selected: ['tests/controlled.test.js'], dependencies: { entries: [{ path: 'tests/controlled.test.js',
    declaredReferences: [], fixtureReferences: [await describeFile(manifest)] }] },
  preflight: { ready: true, tools: [], services: [] }, environment: {} };
  const valid = await captureInputIdentity(options), entry = valid.entries.find(entry => entry.filename === helper);
  assert.equal(valid.ready, true); assert.equal(entry.required, true);
  assert.deepEqual(entry.expectedDigests, [digest], 'optional descriptions cannot downgrade or add mandatory pins');
  content.conflict = { filename: helper, sha256: 'c'.repeat(64), required: true };
  await writeFile(helperManifest, JSON.stringify(content));
  await writeFile(manifest, JSON.stringify({ helperManifest: { filename: helperManifest,
    sha256: createHash('sha256').update(await readFile(helperManifest)).digest('hex'), required: true } }));
  const conflicting = await captureInputIdentity(options);
  assert.equal(conflicting.ready, false, 'every required pin must agree with the bytes used');
  assert.equal(conflicting.entries.find(entry => entry.filename === helper).expectedDigests.length, 2);
});

test('validation rejects malformed explicit required pins while ignoring ordinary DTO paths', async t => {
  const directory = await temporaryInputs(t), fixtures = path.join(directory, 'fixtures'), helpers = path.join(directory, 'helpers');
  await mkdir(fixtures); await mkdir(helpers);
  const manifest = path.join(fixtures, 'provenance.json'), helper = path.join(helpers, 'Oracle.dll');
  const mediaPath = path.join(directory, 'unread-media.mkv');
  await writeFile(helper, 'existing helper whose declared pin is malformed');
  const validDigest = createHash('sha256').update(await readFile(helper)).digest('hex');
  await writeFile(manifest, '{}');
  const options = { selected: ['tests/controlled.test.js'], dependencies: { entries: [{ path: 'tests/controlled.test.js',
    declaredReferences: [], fixtureReferences: [await describeFile(manifest)] }] },
  preflight: { ready: true, tools: [], services: [] }, environment: {} };
  for (const digest of ['a'.repeat(63), 'g'.repeat(64), '', null, 123]) {
    await writeFile(manifest, JSON.stringify({ helper: { filename: helper, sha256: digest, required: true },
      validDuplicate: { filename: helper, sha256: validDigest, required: true },
      historical: { filename: path.join(helpers, 'missing.cs'), sha256: 'historical malformed description' },
      items: [{ Path: mediaPath, required: true }, { path: mediaPath, required: true }] }));
    const identity = await captureInputIdentity(options), entry = identity.entries.find(value => value.filename === helper);
    assert.equal(identity.ready, false); assert.equal(entry.required, true);
    assert.equal(entry.invalidExpectedDigest, true); assert.equal(entry.expectedDigestMatched, false);
    assert.equal(identity.entries.some(value => value.filename === mediaPath), false);
  }
  await writeFile(manifest, JSON.stringify({ helper: { filename: helper, entriesSha256: 'invalid', required: true } }));
  assert.equal((await captureInputIdentity(options)).ready, false);
  for (const secondary of ['', 'b'.repeat(64)]) {
    await writeFile(manifest, JSON.stringify({ helper: { filename: helper, sha256: validDigest,
      entriesSha256: secondary, required: true } }));
    assert.equal((await captureInputIdentity(options)).ready, false, 'a valid first pin cannot hide another invalid or conflicting declaration');
  }
  await writeFile(manifest, JSON.stringify({ items: [{ Path: mediaPath, required: true }, { path: mediaPath, required: true }],
    historical: { filename: path.join(helpers, 'missing.cs'), sha256: 'historical malformed description' } }));
  const ordinary = await captureInputIdentity(options);
  assert.equal(ordinary.ready, true); assert.equal(ordinary.entries.some(value => value.filename === mediaPath), false);
});
