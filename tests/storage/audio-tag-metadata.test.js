import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { applyProbeMetadata } from '../../src/storage/probe-metadata.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

const guid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
function loaded(overrides = {}, libraryOptions = {}) {
  const type = overrides.Type ?? 'Audio';
  const nativeType = type === 'AudioBook' ? 'MediaBrowser.Controller.Entities.AudioBook'
    : 'MediaBrowser.Controller.Entities.Audio.Audio';
  const values = { ...overrides }; delete values.Type;
  return {
    item: applyNativeItemValues(newNativeItemEntity(nativeType), {
      Id: guid('9'), MediaType: 'Audio', IsLocked: false, LockedFields: [], Name: 'Existing title', Album: 'Existing album',
      Artists: ['Existing artist'], AlbumArtists: ['Existing album artist'], Genres: ['Existing genre'], Studios: [], ProviderIds: {}, ...values,
    }),
    context: { people: [] },
    libraryOptions: { ...defaultLibraryOptions(), ...libraryOptions },
  };
}
function info(tags) {
  return normalizeProbe({ format: { duration: '1', format_name: 'flac', tags }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'flac' }] }, { isAudio: true });
}

test('audio tag refresh follows native fill and replace rules for people, lists, gain and provider ids', () => {
  const album = guid('1'), oldAlbum = guid('2'), artist = guid('3');
  const probe = info({ title: 'Tag title', album: 'Tag album', artist: 'Tag artist', album_artist: 'Tag album artist', composer: 'Tag composer', genre: 'Tag genre',
    REPLAYGAIN_TRACK_GAIN: '-4.125 dB', MUSICBRAINZ_ALBUMID: album, MUSICBRAINZ_ARTISTID: artist });
  const current = loaded({ ProviderIds: { MusicBrainzAlbum: oldAlbum } });
  let result = applyProbeMetadata(current, probe);
  assert.equal(result.Item.Name, 'Tag title');
  assert.equal(result.Item.Album, 'Existing album');
  assert.deepEqual(result.Item.Artists, ['Existing artist']);
  assert.deepEqual(result.Item.AlbumArtists, ['Existing album artist']);
  assert.deepEqual(result.Item.Genres, ['Existing genre']);
  assert.equal(result.Item.NormalizationGain, Math.fround(-4.125));
  assert.deepEqual(result.Item.ProviderIds, { MusicBrainzAlbum: oldAlbum, MusicBrainzArtist: artist });
  assert.deepEqual(result.People, [
    { Name: 'Tag album artist', Type: 'AlbumArtist', Role: null },
    { Name: 'Tag artist', Type: 'Artist', Role: null },
    { Name: 'Tag composer', Type: 'Composer', Role: null },
  ]);

  result = applyProbeMetadata(current, probe, { replaceAllMetadata: true });
  assert.equal(result.Item.Album, 'Tag album');
  assert.deepEqual(result.Item.Artists, ['Tag artist']);
  assert.deepEqual(result.Item.AlbumArtists, ['Tag album artist']);
  assert.deepEqual(result.Item.Genres, ['Tag genre']);
  assert.deepEqual(result.Item.ProviderIds, { MusicBrainzAlbum: album, MusicBrainzArtist: artist });
});

test('audiobook nonstandard tags use custom delimiters and native author, narrator and cast roles', () => {
  const recording = guid('4'), album = guid('5');
  const probe = info({
    title: 'Book title', album: 'Book series', artist: 'Ignored standard artist', album_artist: 'Ignored standard author',
    ARTISTS: 'Author/Slash|Actor One', ALBUMARTISTS: 'Author/Slash|Author Two', composer: 'Narrator One\u001fNarrator Two',
    genre: 'Sci/Fi|Drama', description: 'Book overview', publisher: 'Book publisher', date: '2025-03-04',
    MUSICBRAINZ_TRACKID: recording, MUSICBRAINZ_ALBUMID: `${album}|${guid('6')}`,
  });
  const state = loaded({ Type: 'AudioBook', Album: null, Artists: [], AlbumArtists: [], Genres: [], Overview: null }, {
    PreferNonstandardArtistsTag: true, UseCustomTagDelimiters: true, CustomTagDelimiters: ['/', '|'], DelimiterWhitelist: ['Author/Slash', 'Sci/Fi'],
  });
  const result = applyProbeMetadata(state, probe);
  assert.equal(result.Item.Name, 'Book title');
  assert.equal(result.Item.Album, 'Book series');
  assert.deepEqual(result.Item.Artists, ['Author/Slash', 'Actor One']);
  assert.deepEqual(result.Item.AlbumArtists, ['Author/Slash', 'Author Two']);
  assert.deepEqual(result.Item.Genres, ['Sci/Fi', 'Drama']);
  assert.equal(result.Item.Overview, 'Book overview');
  assert.deepEqual(result.Item.Studios, ['Book publisher']);
  assert.equal(result.Item.ProductionYear, 2025);
  assert.match(result.Item.PremiereDate, /^2025-03-04/u);
  assert.deepEqual(result.Item.ProviderIds, { MusicBrainzAlbum: album, MusicBrainzRecording: recording });
  assert.deepEqual(result.People, [
    { Name: 'Author/Slash', Type: 'Author', Role: null },
    { Name: 'Author Two', Type: 'Author', Role: null },
    { Name: 'Narrator One', Type: 'Narrator', Role: null },
    { Name: 'Narrator Two', Type: 'Narrator', Role: null },
    { Name: 'Actor One', Type: 'Actor', Role: null },
  ]);
});

test('audio metadata locks preserve protected tag fields while leaving independent fields refreshable', () => {
  const probe = info({ title: 'New title', artist: 'New artist', album_artist: 'New album artist', genre: 'New genre', REPLAYGAIN_TRACK_GAIN: '-4 dB ' });
  const state = loaded({ LockedFields: ['Name', 'Cast', 'Genres'], NormalizationGain: 1.5 });
  const result = applyProbeMetadata(state, probe, { replaceAllMetadata: true });
  assert.equal(result.Item.Name, 'Existing title');
  assert.deepEqual(result.Item.Artists, ['Existing artist']);
  assert.deepEqual(result.Item.AlbumArtists, ['Existing album artist']);
  assert.deepEqual(result.Item.Genres, ['Existing genre']);
  assert.equal(result.Item.NormalizationGain, 1.5);
  assert.equal(result.People, undefined);
});
