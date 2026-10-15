import test from 'node:test';
import assert from 'node:assert/strict';
import input from './fixtures/subtitle-alias-input.json' with { type: 'json' };
import oracle from './fixtures/subtitle-alias-output.json' with { type: 'json' };
import { convertSubtitle } from '../../src/playback/subtitles.js';
import { mimeType } from '../../src/playback/service.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { assertProjectedEqual } from '../comparison-observations.js';
import { subtitleLayoutProjection } from './layout-projection.js';

test('subtitle writers, aliases and time filtering match the actual SubtitleEncoder DLL', t => {
  const expected = new Map(oracle.subtitles.map(entry => [entry.name, entry]));
  for (const entry of input.subtitles) {
    const native = expected.get(entry.name);
    const run = () => convertSubtitle(entry.text, entry.inputFormat, entry.outputFormat,
      { startPositionTicks: BigInt(entry.start), endPositionTicks: BigInt(entry.end), copyTimestamps: entry.copy });
    if (native.error) assert.throws(run, { status: 400 }, entry.name);
    else {
      const actual = run();
      assertProjectedEqual(t, entry.name, actual, native.text,
        entry.outputFormat.toLowerCase() === 'json' ? parseLosslessJson : value => subtitleLayoutProjection(value, entry.outputFormat));
    }
  }
  for (const [extension, expectedType] of Object.entries(oracle.mimes)) assert.equal(mimeType(`file.${extension}`), expectedType, extension);
});
