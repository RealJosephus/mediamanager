import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getRatingScore } from '../../src/core/localization-data.js';
import { verifyChildMetadataRatingConsumer, verifyCollectionRatingConsumer } from './collection-rating-consumer.js';

const fixture = new URL('./fixtures/parental-rating-unicode/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedScore = value => value.HasScore ? { score: value.Score, subScore: value.SubScore } : null;
const supportedPairs = input.pairs.filter(sample => sample.Ratings.every(value => value == null || !value.includes('\0')));
const nativePair = sample => native.Pairs.find(value => value.Name === sample.Name);

test('rating Unicode fixture binds actual LocalizationManager resources and BaseItem final selection', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(native.InputSha256, proof.inputSha256);
  assert.equal(native.ActualGetRatingScore, true); assert.equal(native.ActualUpdateRatingToItems, true);
  assert.equal(native.ActualEmbeddedRatingResourcesLoaded, true);
  assert.equal(native.MediaOpened, false); assert.equal(native.PortOpened, false);
  assert.equal(native.Scores.length, 63); assert.equal(native.Pairs.length, 23);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.equal(proof.sourceInputsStable, true); assert.equal(proof.phaseAcceptance, false);
  assert.equal(proof.completeBuildInputClosure, false);
  assert.deepEqual(native.Scores.map(({ Name, Rating, Country }) => ({ Name, Rating, Country })), input.scores);
  assert.deepEqual(native.Pairs.map(({ Name, Ratings, Country }) => ({ Name, Ratings, Country })), input.pairs);
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256, source.name);
  assert.equal(hash(await readFile(proof.rawRecording.filename)), proof.nativeSha256);
  assert.equal(hash(await readFile(proof.oracleAssembly.filename)), proof.oracleAssembly.sha256);
  assert.equal(hash(await readFile(new URL('../../tools/compat/record-parental-rating-unicode.mjs', import.meta.url))), proof.recorder.sha256);
  for (const source of proof.sources) for (const name of ['designated', 'isolated']) {
    assert.equal(hash(await readFile(source[name].filename)), source.sha256, source.path);
  }
  for (const assembly of proof.actualLoadedAssemblies) {
    assert.equal(hash(await readFile(assembly.Filename)), assembly.Sha256, assembly.Type);
    assert.ok(proof.dependencies.some(dependency => dependency.sha256 === assembly.Sha256));
  }
});

test('Node rating resolver matches all 63 actual Unicode, numeric and prefix/slash boundary samples', () => {
  for (const [index, sample] of input.scores.entries()) {
    assert.deepEqual(getRatingScore(sample.Rating, sample.Country, 'US'), expectedScore(native.Scores[index]), sample.Name);
  }
});

test('postgres: child metadata preserves native final rating, first spelling, null ordering and whitespace candidates', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  assert.equal(supportedPairs.length, 22);
  await verifyChildMetadataRatingConsumer(t, supportedPairs, nativePair);
});

test('postgres: Collection add publishes all native rating pairs through one update, queue, event and prepared XML', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  await verifyCollectionRatingConsumer(t, input.pairs, nativePair);
});
