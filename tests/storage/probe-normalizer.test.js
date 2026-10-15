import test from 'node:test';
import assert from 'node:assert/strict';
import samples from './fixtures/probe-oracle.json' with { type: 'json' };
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';

test('technical probe fields match the pinned Jellyfin DLL for every recorded stream column', () => {
  for (const sample of samples) {
    const info = normalizeProbe(sample.raw, { path: '/fixture.mkv', isAudio: sample.isAudio });
    const actual = { ...Object.fromEntries(Object.keys(sample.expected).map(key => [key, info[key]])), Size: info.Size == null ? null : String(info.Size), RunTimeTicks: info.RunTimeTicks == null ? null : String(info.RunTimeTicks),
      MediaStreams: info.MediaStreams.map((stream, index) => Object.fromEntries(Object.keys(sample.expected.MediaStreams[index]).map(key => [key, stream[key] ?? null]))),
      Chapters: info.Chapters.map(chapter => ({ ...chapter, StartPositionTicks: String(chapter.StartPositionTicks) })) };
    const expected = structuredClone(sample.expected);
    for (const value of [actual, expected]) for (const stream of value.MediaStreams) for (const key of ['AverageFrameRate', 'RealFrameRate']) if (stream[key] != null) stream[key] = Math.fround(stream[key]);
    assert.deepEqual(actual, expected, sample.name);
  }
});

test('normalization rejects malformed durations and oversized native integers', () => {
  assert.throws(() => normalizeProbe({ format: { duration: 'N/A' } }), { code: 'invalid-response' });
  assert.throws(() => normalizeProbe({ format: { size: '9223372036854775808' } }), { code: 'invalid-response' });
});
