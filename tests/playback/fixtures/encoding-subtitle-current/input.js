import reference from '../extraction-reference.json' with { type: 'json' };

export function encodingSubtitleInput() {
  const profiles = [];
  for (const enabled of [false, true]) for (const external of [false, true]) {
    for (const playMethod of ['DirectPlay', 'DirectStream', 'Transcode']) for (const codec of ['srt', 'pgssub', 'dvdsub']) {
      for (const method of ['External', 'Hls']) profiles.push({ name: [enabled, external, playMethod, codec, method].join(':'), enabled,
        source: { Container: 'mkv', VideoType: 'VideoFile' }, stream: { Type: 'Subtitle', Index: 0, Codec: codec,
          IsExternal: external, Path: external ? '/fixture/sub.' + codec : null, SupportsExternalStream: true },
        profiles: [{ Format: codec, Method: method }], playMethod, protocol: 'hls', container: 'ts' });
    }
  }
  // These are negotiation inputs, not expected outcomes. The actual Native
  // GetSubtitleProfile runs decide whether an external ASS/SSA source can use
  // the VTT Hls profile or the exact-format External control.
  for (const enabled of [false, true]) for (const [codec, language, index] of [['ass', 'eng', 3], ['ssa', 'fra', 4]]) {
    for (const method of ['Hls', 'External']) profiles.push({ name: `external-${codec}-${method}-${enabled}`, enabled,
      source: { Path: 'Z:\\Hls\\source.mkv', Container: 'mkv', VideoType: 'VideoFile', IsInfiniteStream: false },
      stream: { Type: 'Subtitle', Index: index, Codec: codec, Language: language, IsExternal: true,
        Path: 'Z:\\Hls\\fixture.' + codec, SupportsExternalStream: true },
      profiles: method === 'Hls' ? [{ Format: 'vtt', Method: 'Hls', Language: 'eng' }, { Format: 'vtt', Method: 'Hls', Language: 'fra' }]
        : [{ Format: 'ass', Method: 'External', Language: 'eng' }, { Format: 'ssa', Method: 'External', Language: 'fra' }],
      playMethod: 'Transcode', protocol: 'hls', container: 'ts' });
  }
  const original = reference.sources[0];
  const source = { ...original, source: { ...original.source,
    MediaStreams: original.source.MediaStreams.map(stream => stream.Type === 'Subtitle' ? { ...stream, SupportsExternalStream: true } : stream) } };
  return { profiles, source, timeout: [
    { name: 'default-current', minutes: 30 }, { name: 'zero-after-start', minutes: 0, holdBody: true },
    { name: 'negative-after-start', minutes: -1, holdBody: true },
    { name: 'maximum-valid-whole-minutes', minutes: 71582, cancelAfterRead: true, holdBody: true },
    { name: 'first-invalid-whole-minutes', minutes: 71583, holdBody: true },
    { name: 'maximum-int32-minutes', minutes: 2147483647, holdBody: true },
    { name: 'new-current-after-admitted-input', minutes: 30, nextMinutes: 0, holdBody: true },
    { name: 'disabled-explicit-subtitle-is-still-copied', minutes: 30, enabled: false },
    { name: 'real-start-failure', minutes: -1, executableMissing: true },
  ], attachmentBase64: reference.attachment };
}
