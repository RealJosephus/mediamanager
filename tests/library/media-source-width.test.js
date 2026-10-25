import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sortNative } from '../../src/core/native-sort.js';
import { compareMediaSourceWidth, sortMediaSources } from '../../src/library/media-versions.js';
import { observeComparison } from '../comparison-observations.js';

const bytes = readFileSync(new URL('./fixtures/next-up/order-native.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  'dd11105c41d34831ef4a477066a815fd4b6b17ac84303aa32a09ef14fa7cb660');
const native = JSON.parse(bytes);
assert.deepEqual(native.result, { code: 0, signal: null });
assert.deepEqual(native.bindingValidation, { episodes: 109, mediaSources: 78 });
assert.equal(native.phaseAcceptance, false);

test('frozen DLL media source width signs and every descending pair match', t => {
  const magnitudes = [];
  for (let left = 0; left < native.mediaSources.length; left++) {
    for (let right = 0; right < native.mediaSources.length; right++) {
      const actual = compareMediaSourceWidth(native.mediaSources[left], native.mediaSources[right]);
      magnitudes.push({ left, right, value: actual });
      assert.equal(Math.sign(actual), Math.sign(native.widthComparisons[left][right]), `width ${left}/${right}`);
      const indices = [left, right];
      sortNative(indices, (a, b) => -Math.sign(compareMediaSourceWidth(native.mediaSources[a], native.mediaSources[b])));
      assert.deepEqual(indices, native.widthDescendingPairOrder[left][right], `pair ${left}/${right}`);
    }
  }
  observeComparison(t, 'comparer magnitudes', magnitudes.map(value => value.value), native.widthComparisons.flat());
});

test('actual native LINQ width and complete source ordering match 722 recorded sequences', () => {
  assert.equal(native.widthSequences.length, 361);
  assert.equal(native.fullSourceSequences.length, 361);
  for (let index = 0; index < native.widthSequences.length; index++) {
    const entries = native.widthSequences[index].map((source, position) => ({ source, position }));
    sortNative(entries, (a, b) => -Math.sign(compareMediaSourceWidth(native.mediaSources[a.source], native.mediaSources[b.source])));
    assert.deepEqual(entries.map(entry => entry.position), native.widthSequenceOrder[index], `width sequence ${index}`);
    const sequence = native.fullSourceSequences[index];
    const sources = sequence.indices.map((source, position) => ({ ...native.mediaSources[source], position }));
    const sorted = sortMediaSources(sources, sequence.preferredId);
    assert.deepEqual(sorted.map(source => source.position), native.fullSourceSequenceOrder[index], `source sequence ${index}`);
  }
});
