import test from 'node:test';
import assert from 'node:assert/strict';
import input from './fixtures/oracle-input.json' with { type: 'json' };
import oracle from './fixtures/oracle-output.json' with { type: 'json' };
import { negotiateSource } from '../../src/playback/profile.js';
import { convertSubtitle } from '../../src/playback/subtitles.js';
import { getMimeType } from '../../src/http/mime-types.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { assertProjectedEqual } from '../comparison-observations.js';

test('direct playback conditions match the pinned StreamBuilder DLL', () => {
  for (const entry of input.profiles) {
    const expected = oracle.profiles.find(record => record.name === entry.name).result;
    const source = negotiateSource(structuredClone(entry.source), { Id: entry.source.Id, MediaType: entry.mediaType }, entry.profile, entry.options);
    const actual = { SupportsDirectPlay: source.SupportsDirectPlay, AudioStreamIndex: source.DefaultAudioStreamIndex,
      SubtitleStreamIndex: source.DefaultSubtitleStreamIndex, TranscodeReasons: source.TranscodeReasons ?? [] };
    for (const key of Object.keys(actual)) if (actual[key] === undefined) delete actual[key];
    const native = { ...expected, TranscodeReasons: expected.TranscodeReasons.flat() };
    if (entry.name === 'embedded subtitle External') {
      assert.equal(source.SupportsDirectPlay, false, 'Unavailable extraction must not be advertised as playable.');
      assert.deepEqual(source.TranscodeReasons, ['SubtitleCodecNotSupported']);
      assert.equal(expected.SupportsDirectPlay, true, 'Keep the native difference visible.');
    } else assert.deepEqual(actual, native, entry.name);
    assert.equal(source.SupportsTranscoding, false);
    assert.equal(source.TranscodingUrl, undefined);
  }
});

test('subtitle text conversion and filtering match actual SubtitleEncoder values', t => {
  for (const entry of input.subtitles) {
    const actual = convertSubtitle(entry.text, entry.inputFormat, entry.outputFormat,
      { startPositionTicks: BigInt(entry.start), endPositionTicks: BigInt(entry.end), copyTimestamps: entry.copy });
    const expected = oracle.subtitles.find(record => record.name === entry.name).text;
    assertProjectedEqual(t, entry.name, actual, expected, entry.outputFormat.toLowerCase() === 'json' ? parseLosslessJson : undefined);
  }
});

test('media and subtitle MIME types match the pinned DLL', () => {
  for (const [extension, expected] of Object.entries(oracle.mimes)) assert.equal(getMimeType(`file.${extension}`), expected, extension);
});
