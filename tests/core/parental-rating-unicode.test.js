import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getRatingScore } from '../../src/core/localization-data.js';
import { verifyChildMetadataRatingConsumer, verifyCollectionRatingConsumer } from './collection-rating-consumer.js';
import { input, recordCurrentParentalRatingOnce } from './parental-rating-unicode-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const currentOptions = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };
const currentPostgresOptions = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL || !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 300000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedScore = value => value.HasScore ? { score: value.Score, subScore: value.SubScore } : null;
const nativePair = (native, sample) => native.Pairs.find(value => value.Name === sample.Name);

test('rating Unicode oracle records the current designated Native score and final-selection behavior', currentOptions, async () => {
  const { inputBytes, input: currentInput, native } = await recordCurrentParentalRatingOnce();
  assert.equal(native.InputSha256, hash(inputBytes));
  assert.deepEqual(currentInput, input);
  assert.equal(native.Scores.length, 63); assert.equal(native.Pairs.length, 23);
  assert.deepEqual(native.Scores.map(({ Name, Rating, Country }) => ({ Name, Rating, Country })), input.scores);
  assert.deepEqual(native.Pairs.map(({ Name, Ratings, Country }) => ({ Name, Ratings, Country })), input.pairs);
  for (const value of native.Scores) {
    assert.equal(Object.hasOwn(value, 'Exception'), false, value.Name);
    assert.equal(Object.hasOwn(value, 'Error'), false, value.Name);
    assert.equal(typeof value.HasScore, 'boolean', value.Name);
    if (value.HasScore) {
      assert.ok(Number.isInteger(value.Score), value.Name);
      assert.ok(value.SubScore === null || Number.isInteger(value.SubScore), value.Name);
    } else assert.deepEqual({ Score: value.Score, SubScore: value.SubScore }, { Score: null, SubScore: null }, value.Name);
  }
  for (const value of native.Pairs) {
    assert.equal(Object.hasOwn(value, 'Exception'), false, value.Name);
    assert.equal(Object.hasOwn(value, 'Error'), false, value.Name);
    assert.equal(typeof value.Changed, 'boolean', value.Name);
    assert.equal(typeof value.OfficialRating, 'string', value.Name);
  }
});

test('Node rating resolver matches all 63 current Native Unicode, numeric and prefix/slash boundary samples', currentOptions, async () => {
  const { native } = await recordCurrentParentalRatingOnce();
  for (const [index, sample] of input.scores.entries()) {
    assert.deepEqual(getRatingScore(sample.Rating, sample.Country, 'US'), expectedScore(native.Scores[index]), sample.Name);
  }
});

test('postgres: child metadata preserves current Native final rating, first spelling, null ordering and whitespace candidates', currentPostgresOptions, async t => {
  const { native } = await recordCurrentParentalRatingOnce();
  assert.equal(input.pairs.length, 23);
  assert.equal(nativePair(native, input.pairs.find(sample => sample.Name === 'trailing-nul-vs-19')).OfficialRating, '18\0');
  await verifyChildMetadataRatingConsumer(t, input.pairs, sample => nativePair(native, sample));
});

test('postgres: Collection add publishes all current Native rating pairs through one update, queue, event and prepared XML', currentPostgresOptions, async t => {
  const { native } = await recordCurrentParentalRatingOnce();
  await verifyCollectionRatingConsumer(t, input.pairs, sample => nativePair(native, sample));
});
