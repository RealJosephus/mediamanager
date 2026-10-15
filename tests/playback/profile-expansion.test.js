import test from 'node:test';
import assert from 'node:assert/strict';
import input from './fixtures/profile-expansion-input.json' with { type: 'json' };
import oracle from './fixtures/profile-expansion-output.json' with { type: 'json' };
import { negotiateSource, subtitleProfile } from '../../src/playback/profile.js';
import { selectDefaultTracks } from '../../src/library/media-streams.js';

test('audio selection and profile conditions match additional StreamBuilder DLL cases', () => {
  for (const entry of input.profiles) {
    const expected = oracle.profiles.find(record => record.name === entry.name);
    const source = structuredClone(entry.source);
    source.DefaultAudioIndexSource = entry.audioIndexSource ?? 0;
    const run = () => negotiateSource(source, { Id: source.Id, MediaType: entry.mediaType }, entry.profile, entry.options);
    if (expected.error) {
      assert.throws(run, { message: expected.message }, entry.name);
      continue;
    }
    const actual = run();
    const projection = { SupportsDirectPlay: actual.SupportsDirectPlay, AudioStreamIndex: actual.DefaultAudioStreamIndex,
      SubtitleStreamIndex: actual.DefaultSubtitleStreamIndex, TranscodeReasons: actual.TranscodeReasons ?? [] };
    for (const key of Object.keys(projection)) if (projection[key] === undefined) delete projection[key];
    assert.deepEqual(projection, { ...expected.result, TranscodeReasons: expected.result.TranscodeReasons.flat() }, entry.name);
    if (expected.subtitles) assert.deepEqual(actual.MediaStreams.filter(stream => stream.Type === 'Subtitle').map(stream => {
      const delivery = subtitleProfile(actual, stream, entry.profile);
      return { Index: stream.Index, DeliveryMethod: delivery.Method, Format: delivery.Format };
    }), expected.subtitles, `${entry.name} delivery`);
  }
});

test('track selection retains native preference flags without exposing them in JSON', () => {
  const streams = [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1, Codec: 'aac', Language: 'eng' },
    { Type: 'Audio', Index: 2, Codec: 'aac', Language: 'jpn', IsDefault: true, IsOriginal: true }];
  const cases = [
    [{}, {}, 2, 0],
    [{ PlayDefaultAudioTrack: true }, {}, 2, 1],
    [{ AudioLanguagePreference: 'English' }, {}, 1, 2],
    [{ AudioLanguagePreference: 'English', PlayDefaultAudioTrack: true }, {}, 2, 3],
    [{ RememberAudioSelections: true, AudioLanguagePreference: 'English', PlayDefaultAudioTrack: true }, { AudioStreamIndex: 1 }, 1, 4],
    [{ AudioLanguagePreference: 'OriginalLanguage' }, {}, 2, 0],
    [{ AudioLanguagePreference: 'OriginalLanguage', PlayDefaultAudioTrack: true }, {}, 2, 0],
  ];
  for (const [configuration, data, index, flags] of cases) {
    const source = { MediaStreams: structuredClone(streams) };
    selectDefaultTracks(source, { MediaType: 'Video', OriginalLanguage: 'jpn' }, { Configuration: configuration }, data);
    assert.equal(source.DefaultAudioStreamIndex, index);
    assert.equal(source.DefaultAudioIndexSource, flags);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(source)), 'DefaultAudioIndexSource'), false);
  }
});
