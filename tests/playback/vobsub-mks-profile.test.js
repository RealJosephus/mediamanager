import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { negotiateSource, subtitleProfile } from '../../src/playback/profile.js';

const nativeBytes = await readFile(new URL('./fixtures/vobsub-delivery/native-dll.json', import.meta.url));
assert.equal(createHash('sha256').update(nativeBytes).digest('hex'), 'fe47a1e8dc0d74bbab057c8007c88b869a0c8b72acc164a7b286c815fd45fecb');
const native = JSON.parse(nativeBytes);

const mksProfile = format => ({
  SubtitleProfiles: [{ Format: format, Container: 'mks', Method: 'External' }],
});

test('VobSub MKS profiles only select streams that can be delivered as MKS', () => {
  const source = { Container: 'mkv' };
  const cases = [
    { name: 'embedded vobsub', profile: 'vobsub', stream: { Codec: 'vobsub', IsExternal: false }, method: 'External', canExtract: false },
    { name: 'embedded dvdsub', profile: 'dvdsub', stream: { Codec: 'dvdsub', IsExternal: false }, method: 'External' },
    { name: 'external MKS', profile: 'vobsub', stream: { Codec: 'vobsub', IsExternal: true, Path: '/media/sub.MKS' }, method: 'External', canExtract: false },
    { name: 'external IDX', profile: 'vobsub', stream: { Codec: 'vobsub', IsExternal: true, Path: '/media/sub.idx' }, method: 'Encode' },
    { name: 'external SUB', profile: 'vobsub', stream: { Codec: 'vobsub', IsExternal: true, Path: '/media/sub.sub' }, method: 'Encode' },
  ];

  for (const entry of cases) {
    const actual = subtitleProfile(source, { Type: 'Subtitle', Index: 0, SupportsExternalStream: true, ...entry.stream }, mksProfile(entry.profile), source.Container,
      { PlayMethod: 'Transcode', CanExtractSubtitle: () => entry.canExtract ?? true });
    assert.deepEqual(actual, { Method: entry.method, Format: entry.stream.Codec }, entry.name);
  }
});

test('equal-score default selection prefers an MKS-deliverable VobSub stream over IDX', () => {
  const source = {
    Id: '11111111111111111111111111111111',
    Container: 'mkv',
    Bitrate: 1000,
    SupportsDirectPlay: true,
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: 2,
    MediaAttachments: [],
    MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'h264' },
      { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true },
      { Type: 'Subtitle', Index: 2, Codec: 'vobsub', IsExternal: true, Path: '/media/sub.idx', Score: 10, SupportsExternalStream: true },
      { Type: 'Subtitle', Index: 3, Codec: 'vobsub', IsExternal: false, Score: 10, SupportsExternalStream: true },
    ],
  };
  const profile = {
    ...mksProfile('vobsub'),
    MaxStreamingBitrate: 8_000_000,
    DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'h264', AudioCodec: 'aac' }],
  };

  const actual = negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, profile, { CanExtractSubtitle: () => true });

  assert.equal(actual.DefaultSubtitleStreamIndex, 3);
  assert.equal(actual.MediaStreams[2].DeliveryMethod, 'Encode');
  assert.equal(actual.MediaStreams[3].DeliveryMethod, 'External');
  assert.match(actual.MediaStreams[3].DeliveryUrl, /\/Stream\.vobsub$/u);
  assert.equal(actual.MediaStreams[3].Codec, 'vobsub');
});

test('DVDSub MKS delivery preserves the native profile format in the advertised URL', () => {
  const source = {
    Id: '11111111111111111111111111111111', Container: 'mkv', MediaStreams: [
      { Type: 'Subtitle', Index: 3, Codec: 'dvdsub', IsExternal: false },
    ], MediaAttachments: [],
  };
  const actual = negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, mksProfile('dvdsub'), { AccessToken: 'secret' });
  assert.equal(actual.MediaStreams[0].DeliveryMethod, 'External');
  assert.equal(actual.MediaStreams[0].Codec, 'dvdsub');
  assert.match(actual.MediaStreams[0].DeliveryUrl, /\/Stream\.dvdsub\?ApiKey=secret$/u);
});

test('six actual frozen DLL subtitle selections and advertisement suffixes match', () => {
  assert.equal(native.actualFrozenStreamBuilder, true);
  assert.equal(native.actualFrozenStreamInfo, true);
  assert.equal(native.advertisements.length, 6);
  for (const expected of native.advertisements) {
    const source = { Id: '22222222222222222222222222222222', Container: 'mkv',
      MediaStreams: [{ Type: 'Subtitle', Index: 3, Codec: expected.codec, IsExternal: expected.external,
        Path: expected.path, SupportsExternalStream: true }], MediaAttachments: [] };
    const profile = { SubtitleProfiles: [expected.profile] };
    assert.deepEqual(subtitleProfile(source, source.MediaStreams[0], profile, source.Container,
      { CanExtractSubtitle: () => false }), { Method: expected.selected.Method, Format: expected.selected.Format }, expected.name);
    negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, profile, { CanExtractSubtitle: () => false });
    const actual = source.MediaStreams[0];
    const advertisement = expected.advertisements[0];
    assert.equal(actual.DeliveryMethod, advertisement.Method, expected.name);
    assert.equal(actual.Codec, expected.codec, expected.name);
    assert.equal(actual.DeliveryUrl ?? null, advertisement.Url?.replace('/controlled', '') ?? null, expected.name);
  }
});

test('VobSub MKS handling preserves configured external profile order', () => {
  const source = { Container: 'mkv' };
  const stream = { Type: 'Subtitle', Index: 0, Codec: 'vobsub', IsExternal: false, SupportsExternalStream: true };
  const profile = {
    SubtitleProfiles: [
      { Format: 'vobsub', Method: 'External' },
      { Format: 'dvdsub', Container: 'mks', Method: 'External' },
    ],
  };

  assert.deepEqual(subtitleProfile(source, stream, profile, source.Container,
    { PlayMethod: 'Transcode', CanExtractSubtitle: () => true }), { Method: 'External', Format: 'vobsub' });
});

test('exact external matches remain ahead of earlier conversion profiles', () => {
  const source = { Container: 'mkv' };
  const stream = { Type: 'Subtitle', Index: 0, Codec: 'srt', IsExternal: false, IsTextSubtitleStream: true, SupportsExternalStream: true };
  const profile = {
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
    ],
  };

  assert.deepEqual(subtitleProfile(source, stream, profile, source.Container,
    { PlayMethod: 'Transcode', CanExtractSubtitle: () => true }), { Method: 'External', Format: 'srt' });
});

test('the conversion pass retains ASS and SSA HLS WebVTT delivery', () => {
  const source = { Container: 'mkv' };
  const profile = { SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls' }] };

  for (const codec of ['ass', 'ssa']) for (const isExternal of [false, true]) {
    const stream = { Type: 'Subtitle', Index: 0, Codec: codec, IsExternal: isExternal, IsTextSubtitleStream: true,
      SupportsExternalStream: true, Path: isExternal ? `/media/subtitle.${codec}` : undefined };
    assert.deepEqual(subtitleProfile(source, stream, profile, source.Container,
      { PlayMethod: 'Transcode', CanExtractSubtitle: () => true }), { Method: 'Hls', Format: 'vtt' }, `${codec}/${isExternal ? 'external' : 'embedded'}`);
  }
});
