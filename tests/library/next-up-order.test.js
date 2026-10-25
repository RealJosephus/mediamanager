import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { airedEpisodeOrder, sortAiredEpisodes } from '../../src/library/next-up.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/next-up/order-native.json', import.meta.url), 'utf8'));
test('AiredEpisodeOrder matches frozen DLL for nullable placements, int32 arithmetic and 100ns date ties', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.phaseAcceptance, false);
  assert.deepEqual(fixture.result, { code: 0, signal: null });
  assert.deepEqual(fixture.bindingValidation, { episodes: 109, mediaSources: 78 });
  assert.equal(fixture.episodes.length, 109);
  assert.equal(fixture.comparisons.length, fixture.episodes.length);
  for (const [leftIndex, left] of fixture.episodes.entries()) {
    assert.equal(fixture.comparisons[leftIndex].length, fixture.episodes.length);
    for (const [rightIndex, right] of fixture.episodes.entries()) {
      assert.equal(Math.sign(airedEpisodeOrder(left, right)) || 0, fixture.comparisons[leftIndex][rightIndex],
        JSON.stringify({ left, right }));
    }
  }
});

test('specials use actual native LINQ ordering for nontransitive aired-episode sequences', async () => {
  const native = JSON.parse(await readFile(new URL('./fixtures/next-up/episode-sequence-native.json', import.meta.url), 'utf8'));
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.phaseAcceptance, false);
  assert.deepEqual(native.result, { code: 0, signal: null });
  assert.equal(native.bindingValidated, 109);
  assert.equal(native.sequences.length, 386);
  assert.equal(native.orders.length, native.sequences.length);
  for (const [index, indices] of native.sequences.entries()) {
    const items = indices.map((episode, position) => ({ ...native.episodes[episode], position }));
    assert.deepEqual(sortAiredEpisodes(items).map(item => item.position), native.orders[index], `sequence ${index}`);
  }
});
