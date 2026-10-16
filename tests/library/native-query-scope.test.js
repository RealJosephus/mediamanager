import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeQueryInputs, readNativeQueryBoundFile } from './native-query-inputs.js';
import { assertCompleteNativeFilterHttpRepeat } from './full-filter-wire.js';
import { verifyNativeItemFilterEvidence, verifyNativeItemFilterEvidenceContract } from './native-item-filter-evidence.js';
import { nativeReferencePreparationInputs, resolveNativeReferencePreparationInput,
  verifyNativeReferencePreparation } from './native-reference-preparation.js';
import { seedNativeFilterInput } from './native-filter-input.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = (filename, bytes) => ({ filename, bytes: bytes.length, sha256: digest(bytes) });

test('shared query helpers require explicit inputs before opening evidence or a source database', async () => {
  const required = /Explicit native query inputs are required/u;
  assert.throws(() => nativeReferencePreparationInputs('item-filter'), required);
  assert.throws(() => resolveNativeReferencePreparationInput('item-filter', 'undeclared'), required);
  await assert.rejects(verifyNativeReferencePreparation({ profile: 'item-filter' }), required);
  await assert.rejects(verifyNativeItemFilterEvidence({}), required);
  await assert.rejects(verifyNativeItemFilterEvidenceContract({}), required);
  await assert.rejects(seedNativeFilterInput({}, 'synthetic'), required);
});

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'mediamanager-native-query-scope-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('mediamanager-native-query-scope-'));
    await rm(root, { recursive: true, force: true });
  });
  const preparationInputFiles = [];
  const serverId = '1234567890abcdef1234567890abcdef';
  for (let index = 0; index < 11; index++) {
    const filename = path.join(root, index === 0 ? 'bootstrap.json' : 'input-' + index);
    const bytes = Buffer.from(index === 0 ? JSON.stringify({ observations: [{ route: '/Users/AuthenticateByName',
      responseBody: { SessionInfo: { ServerId: serverId } } }] }) : 'synthetic-input-' + index);
    await writeFile(filename, bytes);
    preparationInputFiles.push({ kind: 'synthetic-' + index, ...descriptor(filename, bytes) });
  }
  const sourceBytes = Buffer.from('synthetic-source-only');
  const source = path.join(root, 'source.db');
  await writeFile(source, sourceBytes);
  const output = path.join(root, 'output');
  await mkdir(path.join(output, 'evidence'), { recursive: true });
  const recorder = path.join(output, 'evidence', 'record-native.mjs');
  const captured = await readFile(new URL('../../tools/compat/record-item-filter-native.mjs', import.meta.url));
  await writeFile(recorder, captured);
  return { root, captured, recorder, serverId, binding: {
    reference: { sourceDatabase: descriptor(source, sourceBytes),
      preparationInputs: preparationInputFiles.map(entry => [entry.kind, entry.filename]) },
    preparationInputFiles, independentNativeAudits: [], recordedFilterOutputRoot: output,
    recordedRecorder: descriptor(recorder, captured), expectedChangedReferences: [],
  } };
}

test('explicit query scope reads only its exact source, bootstrap and input allowlist', async t => {
  const { binding, serverId, root } = await fixture(t);
  const inputs = createNativeQueryInputs(binding);
  await inputs.verifySourceBindings();
  assert.equal(await inputs.readServerId(), serverId);
  assert.equal(inputs.resolveInput(binding.reference.preparationInputs[0][1]), binding.preparationInputFiles[0].filename);
  assert.throws(() => inputs.resolveInput(path.join(root, 'not-declared')), /exact profile allowlist/u);
  await writeFile(binding.reference.sourceDatabase.filename, 'changed');
  await assert.rejects(inputs.verifySourceBindings());
});

test('query scope refuses incomplete, reordered and duplicate preparation descriptors', async t => {
  const { binding } = await fixture(t);
  for (const mutate of [
    value => value.preparationInputFiles.pop(),
    value => value.preparationInputFiles.reverse(),
    value => { value.reference.preparationInputs[1] = value.reference.preparationInputs[0]; },
  ]) {
    const candidate = structuredClone(binding);
    mutate(candidate);
    assert.throws(() => createNativeQueryInputs(candidate));
  }
});

test('captured recorder identity is required and cannot use current source or another output root', async t => {
  const { binding } = await fixture(t);
  const missing = structuredClone(binding); delete missing.recordedRecorder;
  await assert.rejects(createNativeQueryInputs(missing).readRecorderSource(), /immutable captured recorder/u);
  const outside = structuredClone(binding);
  outside.recordedRecorder.filename = path.resolve('tools/compat/record-item-filter-native.mjs');
  await assert.rejects(createNativeQueryInputs(outside).readRecorderSource(), /recorded output root/u);
  const wrongHash = structuredClone(binding); wrongHash.recordedRecorder.sha256 = '0'.repeat(64);
  await assert.rejects(createNativeQueryInputs(wrongHash).readRecorderSource());
});

test('captured launch comments retain identity while current seed and matrix correspondence stay strict', async t => {
  const { binding, captured, recorder } = await fixture(t);
  assert.equal(await createNativeQueryInputs(binding).readRecorderSource(), captured.toString('utf8'));
  const crlf = Buffer.from(captured.toString('utf8').replaceAll('\n', '\r\n'));
  await writeFile(recorder, crlf);
  const changedEncoding = structuredClone(binding); changedEncoding.recordedRecorder = descriptor(recorder, crlf);
  assert.equal(await createNativeQueryInputs(changedEncoding).readRecorderSource(), crlf.toString('utf8'));
  const launchOnly = Buffer.from(captured.toString('utf8') + '\n// Synthetic capture launch note.\n');
  await writeFile(recorder, launchOnly);
  const changedLaunch = structuredClone(binding); changedLaunch.recordedRecorder = descriptor(recorder, launchOnly);
  assert.equal(await createNativeQueryInputs(changedLaunch).readRecorderSource(), launchOnly.toString('utf8'));
  const changedSeed = Buffer.from(captured.toString('utf8').replace('function ancestorsFor(item)', 'function ancestorsFor(changedItem)'));
  await writeFile(recorder, changedSeed);
  const incoherent = structuredClone(binding); incoherent.recordedRecorder = descriptor(recorder, changedSeed);
  await assert.rejects(createNativeQueryInputs(incoherent).readRecorderSource(), /unique start|semantics changed/u);
});

test('bound input corruption is fatal and complete native repeats preserve successful nested DTO fields', async t => {
  const { binding } = await fixture(t);
  const wrong = { ...binding.reference.sourceDatabase, sha256: '0'.repeat(64) };
  await assert.rejects(readNativeQueryBoundFile(wrong));
  const serverId = '1234567890abcdef1234567890abcdef';
  const record = body => ({ name: 'one', endpoint: 'items', query: 'ImageTypes=Primary', route: '/Items?ImageTypes=Primary',
    expectedStatus: 200, scope: ['one'], response: { status: 200, contentType: 'application/json',
      bodyText: JSON.stringify(body), bodyJson: body } });
  const body = { Items: [{ Id: 'one', ServerId: serverId, Nested: { Kept: true } }], TotalRecordCount: 1, StartIndex: 0 };
  const original = { records: [record(body)] };
  assert.equal(assertCompleteNativeFilterHttpRepeat(original, structuredClone(original),
    { leftServerId: serverId, rightServerId: serverId }).responses, 1);
  const changed = structuredClone(body); delete changed.Items[0].Nested;
  assert.throws(() => assertCompleteNativeFilterHttpRepeat(original, { records: [record(changed)] },
    { leftServerId: serverId, rightServerId: serverId }));
});
