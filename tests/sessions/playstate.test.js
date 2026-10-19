import test from 'node:test';
import assert from 'node:assert/strict';
import oracle from './fixtures/playstate-oracle.json' with { type: 'json' };
import { defaultUserData, updatePlayState, int64, nativeDate } from '../../src/sessions/user-data.js';
import { bindPlaybackReport } from '../../src/sessions/binding.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import binding from './fixtures/playback-binding.json' with { type: 'json' };

test('native DLL UpdatePlayState differential: 360 Int64, minimum, maximum, audiobook and unsupported cases', () => {
  for (const entry of oracle) {
    const item = { Type: entry.Type === 'Trailer' ? 'Video' : entry.Type, RunTimeTicks: BigInt(entry.Duration), ...(entry.Type === 'Trailer' ? { ExtraType: 'Trailer' } : {}) };
    const data = defaultUserData('oracle');
    const completed = updatePlayState(item, data, entry.Position == null ? null : BigInt(entry.Position));
    assert.deepEqual({ Played: data.Played, Position: String(data.PlaybackPositionTicks), Completed: completed }, { Played: entry.Played, Position: entry.PlaybackPositionTicks, Completed: entry.Completed }, JSON.stringify(entry));
  }
});

test('actual DLL playback DTO binding retains native enum and number behavior', () => {
  for (const entry of binding) {
    if (entry.Error) assert.throws(() => bindPlaybackReport(parseLosslessJson(entry.Input)), { status: 400 }, entry.Input);
    else assert.deepEqual(parseLosslessJson(stringifyNativeJson(bindPlaybackReport(parseLosslessJson(entry.Input)))), parseLosslessJson(entry.Result), entry.Input);
  }
});

test('native SQLite DateTime representation trims fractional zeros without losing seven-digit precision', () => {
  assert.equal(nativeDate(new Date('2026-09-26T12:00:00.000Z')), '2026-09-26 12:00:00');
  assert.equal(nativeDate(new Date('2026-09-26T12:00:00.120Z')), '2026-09-26 12:00:00.12');
  assert.equal(nativeDate('2026-09-26T12:00:00.1234567Z'), '2026-09-26 12:00:00.1234567');
});

test('Int64 inputs are rejected before precision loss and watched progress does not reset Played', () => {
  assert.throws(() => int64(Number.MAX_SAFE_INTEGER + 1), /exact/);
  assert.throws(() => int64('9223372036854775808'), /range/);
  const data = { ...defaultUserData('movie'), Played: true };
  updatePlayState({ Type: 'Movie', RunTimeTicks: 72000000000n }, data, 1n);
  assert.equal(data.Played, true);
  assert.equal(data.PlaybackPositionTicks, 0n);
});
