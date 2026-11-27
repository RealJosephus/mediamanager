import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, selectDefaultTracks } from '../../src/library/media-streams.js';

test('regional playback preferences fall back to the base-language audio and subtitle tracks', () => {
  const source = {
    MediaStreams: [
      { Type: 'Audio', Language: 'eng', Index: 1 },
      { Type: 'Audio', Language: 'por', Index: 2 },
      { Type: 'Subtitle', Language: 'por', Index: 3, IsForced: false },
    ],
  };
  selectDefaultTracks(
    source,
    { MediaType: 'Video' },
    {
      Configuration: {
        AudioLanguagePreference: 'pt-br',
        SubtitleLanguagePreference: 'pt-br',
        SubtitleMode: 'Always',
        PlayDefaultAudioTrack: false,
      },
    }
  );
  assert.deepEqual([source.DefaultAudioStreamIndex, source.DefaultSubtitleStreamIndex ?? null], [2, 3]);
});

test('regional tags rank the exact track before the base language and retain legacy inputs', () => {
  assert.deepEqual(normalizeLanguage('pob'), ['pt-br', 'por', 'pob']);
  assert.deepEqual(normalizeLanguage('fr-ca'), ['fr-ca', 'frc', 'fra', 'fre']);
  const source = {
    MediaStreams: [
      { Type: 'Audio', Index: 1, Language: 'por' },
      { Type: 'Audio', Index: 2, Language: 'pt-br' },
    ],
  };
  selectDefaultTracks(
    source,
    { MediaType: 'Video' },
    { Configuration: { AudioLanguagePreference: 'pt-br', PlayDefaultAudioTrack: false } }
  );
  assert.equal(source.DefaultAudioStreamIndex, 2);
});
