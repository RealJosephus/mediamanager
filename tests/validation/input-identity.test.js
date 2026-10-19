import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFile } from '../../tools/validation/inventory.js';
import { captureInputIdentity, inputsUnchanged } from '../../tools/validation/inputs.js';
import { resultOutcome } from '../../tools/validation/run.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

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
