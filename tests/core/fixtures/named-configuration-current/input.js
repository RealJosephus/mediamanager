import model from '../../../../src/core/resources/configuration-model.json' with { type: 'json' };

export function namedConfigurationInput() {
  const metadata = '<MetadataConfiguration><UseFileCreationTimeForDateAdded>true</UseFileCreationTimeForDateAdded></MetadataConfiguration>';
  const core = [
    { name: 'lazy-missing-malformed-and-warm-key-values', key: 'metadata', steps: [
      { action: 'get', key: 'metadata', retain: 'original' },
      { action: 'xml', value: '<MetadataConfiguration><UseFileCreationTimeForDateAdded>broken</UseFileCreationTimeForDateAdded></MetadataConfiguration>' },
      { action: 'get', key: 'METADATA' },
      { action: 'xml', value: metadata.replace('true', 'false') }, { action: 'get', key: 'MeTaDaTa' },
    ] },
    { name: 'metadata-aliases-retained-incoming-and-cold-value', key: 'metadata', xml: metadata, steps: [
      { action: 'get', key: 'metadata', retain: 'previous' }, { action: 'get', key: 'METADATA' },
      { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false }, retain: 'incoming' },
      { action: 'mutate', retain: 'incoming', values: { UseFileCreationTimeForDateAdded: true } },
      { action: 'get', key: 'metadata', retain: 'current' },
      { action: 'mutate', retain: 'current', values: { UseFileCreationTimeForDateAdded: false } },
      { action: 'mutate', retain: 'previous', values: { UseFileCreationTimeForDateAdded: true } },
      { action: 'saveRetained', key: 'metadata', retain: 'incoming' }, { action: 'get', key: 'mETADATA' },
      { action: 'save', key: 'METADATA', values: { UseFileCreationTimeForDateAdded: true } }, { action: 'get', key: 'metadata' },
    ] },
    { name: 'encoding-retained-incoming-current-and-old-root-fields', key: 'encoding', steps: [
      { action: 'get', key: 'encoding', retain: 'previous' }, { action: 'get', key: 'ENCODING' },
      { action: 'save', key: 'encoding', values: { EnableFallbackFont: true, HardwareDecodingCodecs: ['h264', 'vp9'] }, retain: 'incoming' },
      { action: 'mutate', retain: 'incoming', values: { FallbackFontPath: 'late-incoming-fonts', HardwareDecodingCodecs: ['hevc'] } },
      { action: 'get', key: 'encoding', retain: 'current' },
      { action: 'mutate', retain: 'current', values: { FallbackFontPath: 'reverse-current-fonts', EnableAudioVbr: true } },
      { action: 'mutate', retain: 'previous', values: { FallbackFontPath: 'old-root-only', HardwareDecodingCodecs: ['old-codec'] } },
      { action: 'saveRetained', key: 'encoding', retain: 'incoming' }, { action: 'get', key: 'eNCODING' },
    ] },
    { name: 'linked-directory-get-save-late-incoming-and-cold-target', key: 'metadata', directoryLink: true, xml: metadata, steps: [
      { action: 'get', key: 'metadata', retain: 'previous' },
      { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false }, retain: 'incoming' },
      { action: 'mutate', retain: 'incoming', values: { UseFileCreationTimeForDateAdded: true } },
      { action: 'get', key: 'metadata', retain: 'current' },
      { action: 'saveRetained', key: 'metadata', retain: 'incoming' }, { action: 'get', key: 'METADATA' },
    ] },
    { name: 'lazy-directory-is-not-a-configuration-file', key: 'metadata', xml: metadata, steps: [
      { action: 'physical', mode: 'target-directory' }, { action: 'get', key: 'metadata' },
    ] },
    ...['updating', 'updated'].map(phase => ({ name: phase + '-failure-prefix', key: 'metadata', xml: metadata, steps: [
      { action: 'get', key: 'metadata' }, { action: 'observer', phase },
      { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false }, retain: 'incoming' },
      { action: 'get', key: 'metadata' },
    ] })),
    { name: 'readonly-keeps-adopted-live-and-original-file', key: 'metadata', xml: metadata, steps: [
      { action: 'get', key: 'metadata' }, { action: 'physical', mode: 'readonly' },
      { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false }, retain: 'incoming' },
      { action: 'get', key: 'metadata' }, { action: 'physical', mode: 'writable' },
    ] },
    { name: 'target-directory-keeps-adopted-live', key: 'metadata', xml: metadata, steps: [
      { action: 'get', key: 'metadata' }, { action: 'physical', mode: 'target-directory' },
      { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false } }, { action: 'get', key: 'metadata' },
    ] },
    { name: 'encoding-validation-and-updating-mutation', key: 'encoding', steps: [
      { action: 'get', key: 'encoding' },
      { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/missing' } },
      { action: 'save', key: 'encoding', values: { EncoderAppPath: 'cannot-change-encoder' } },
      { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/transcodes', EnableAudioVbr: true } },
      { action: 'observer', phase: 'mutate-path' },
      { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/transcodes', EnableFallbackFont: true } },
    ] },
    { name: 'encoding-formatter-keeps-new-live-and-physical-prefix', key: 'encoding', steps: [
      { action: 'get', key: 'encoding' },
      { action: 'save', key: 'encoding', values: { EnableFallbackFont: true, HardwareAccelerationType: 999 } },
      { action: 'get', key: 'encoding' }, { action: 'get', key: 'ENCODING' },
    ] },
    { name: 'unknown-xml-content-and-real-native-cold-reader', key: 'metadata',
      xml: '<MetadataConfiguration xmlns:u="urn:future" u:flag="retained">before<u:extra>original</u:extra><UseFileCreationTimeForDateAdded>true</UseFileCreationTimeForDateAdded>after</MetadataConfiguration>',
      steps: [{ action: 'get', key: 'metadata' }, { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false } }] },
    ...['io', 'race-delete'].map(mode => ({ name: 'read-after-exists-' + mode, key: 'metadata', xml: metadata, steps: [
      { action: 'readMode', mode }, { action: 'get', key: 'metadata' }, { action: 'readMode', mode: '' },
      { action: 'xml', value: metadata.replace('true', 'false') }, { action: 'get', key: 'metadata' },
    ] })),
  ];
  const http = [];
  const completeEncoding = Object.fromEntries(Object.entries(model.definitions.EncodingOptions.fields).map(([name, field]) => [name,
    field.type.kind === 'boolean' ? !model.definitions.EncodingOptions.defaults[name]
      : field.type.kind === 'integer' ? 17 : field.type.kind === 'number' ? 1.25
        : field.type.kind === 'enum' ? field.type.members[1]?.name ?? field.type.members[0].name
          : field.type.kind === 'array' ? ['controlled-a', 'controlled-b']
            : name === 'EncoderAppPath' ? null : name === 'TranscodingTempPath' ? '@/transcodes' : 'Controlled ' + name]));
  http.push({ name: 'encoding-complete-public-fields', key: 'encoding', method: 'POST', body: JSON.stringify(completeEncoding) });
  for (const key of ['encoding', 'metadata']) {
    for (const identity of ['anonymous', 'invalid', 'regular', 'admin', 'apiKey']) {
      http.push({ name: key + '-get-' + identity, key, identity, method: 'GET' });
      http.push({ name: key + '-post-' + identity, key, identity, method: 'POST', body: '{}' });
    }
    for (const [label, body] of [['defaults', '{}'], ['root-null', 'null'], ['root-array', '[]'], ['root-number', '42'],
      ['root-string', '"value"'], ['empty', ''], ['malformed', '{"broken":'], ['unknown', '{"Unknown":{"nested":[1,true,null]}}']]) {
      http.push({ name: key + '-' + label, key, method: 'POST', body });
    }
    http.push({ name: key + '-unsupported-media-type', key, method: 'POST', body: '{}', contentType: 'text/plain' });
  }
  for (const [label, body] of [
    ['metadata-false', '{"UseFileCreationTimeForDateAdded":false}'],
    ['metadata-case-sensitive', '{"useFileCreationTimeForDateAdded":false}'],
    ['metadata-last-token', '{"UseFileCreationTimeForDateAdded":false,"UseFileCreationTimeForDateAdded":true}'],
    ['metadata-bool-string', '{"UseFileCreationTimeForDateAdded":"false"}'],
    ['metadata-bool-null', '{"UseFileCreationTimeForDateAdded":null}'],
  ]) http.push({ name: label, key: 'metadata', method: 'POST', body });
  for (const [label, body] of [
    ['encoding-quoted-primitives', '{"EncodingThreadCount":"-2147483648","H264Crf":"2147483647","DownMixAudioBoost":"2.75","FallbackFontPath":false,"HardwareDecodingCodecs":["h264",12,null],"HardwareAccelerationType":"NVENC"}'],
    ['encoding-case-sensitive', '{"enableFallbackFont":true,"encodingThreadCount":8}'],
    ['encoding-last-token', '{"EnableFallbackFont":false,"EnableFallbackFont":true,"EncodingThreadCount":"2","EncodingThreadCount":"7"}'],
    ['encoding-bool-string', '{"EnableFallbackFont":"true"}'], ['encoding-integer-null', '{"EncodingThreadCount":null}'],
    ['encoding-integer-overflow', '{"EncodingThreadCount":"2147483648"}'], ['encoding-floating-integer', '{"EncodingThreadCount":1.0}'],
    ['encoding-invalid-enum', '{"HardwareAccelerationType":"not-an-encoder"}'],
    ['encoding-unknown-numeric-enum', '{"EnableFallbackFont":true,"HardwareAccelerationType":999}'],
    ['encoding-reference-null', '{"FallbackFontPath":null,"HardwareDecodingCodecs":null,"AllowOnDemandMetadataBasedKeyframeExtractionForExtensions":null}'],
    ['encoding-float-special', '{"DownMixAudioBoost":"NaN"}'],
    ['encoding-missing-transcode', '{"TranscodingTempPath":"@/missing"}'],
    ['encoding-invalid-transcode-path', '{"TranscodingTempPath":"\\u0000"}'],
    ['encoding-existing-transcode', '{"TranscodingTempPath":"@/transcodes"}'],
    ['encoding-cannot-change-encoder', '{"EncoderAppPath":"not-a-new-executable"}'],
  ]) http.push({ name: label, key: 'encoding', method: 'POST', body });
  http.push({ name: 'unknown-get', key: 'unknown', method: 'GET' }, { name: 'unknown-post', key: 'unknown', method: 'POST', body: '{}' });
  http.push({ name: 'metadata-malformed-xml-get-keeps-original', key: 'metadata', method: 'GET', invalidXml: true,
    xml: metadata.replace('true', 'broken') },
  { name: 'metadata-read-deleted-after-exists', key: 'metadata', method: 'GET', xml: metadata, readMode: 'race-delete' },
  { name: 'metadata-read-target-directory', key: 'metadata', method: 'GET', xml: metadata, physical: 'target-directory' },
  { name: 'metadata-readonly-save-keeps-live-and-old-file', key: 'metadata', method: 'POST', xml: metadata, physical: 'readonly',
    body: '{"UseFileCreationTimeForDateAdded":false}' });
  for (const phase of ['updating', 'updated']) http.push({ name: 'http-' + phase + '-failure', key: 'metadata', method: 'POST',
    body: '{"UseFileCreationTimeForDateAdded":false}', observer: phase });
  const paths = [{ name: 'canonical-transcode-path-and-recursive-markers', directories: ['a', 'b', 'foreign/nested'], steps: [
    { action: 'get', name: 'null-falls-back-to-current-cache' },
    { action: 'write', filename: '@/cache/transcodes/.jellyfin-transcode', value: 'preserved-default-marker' },
    { action: 'save', key: 'encoding', values: { TranscodingTempPath: '' } },
    { action: 'get', name: 'empty-falls-back-and-keeps-marker' },
    { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/a' } }, { action: 'get', name: 'explicit-a' },
    { action: 'write', filename: '@/a/.jellyfin-transcode', value: 'preserved-a-marker' },
    { action: 'save', key: 'metadata', values: { UseFileCreationTimeForDateAdded: false } }, { action: 'get', name: 'metadata-save-keeps-current-a' },
    { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/b' } }, { action: 'get', name: 'explicit-b-after-replacement' },
    { action: 'write', filename: '@/foreign/nested/.jellyfin-data', value: 'foreign-marker-bytes' },
    { action: 'save', key: 'encoding', values: { TranscodingTempPath: '@/foreign' } }, { action: 'get', name: 'nested-foreign-marker-rejects' },
  ] }];
  return { core, http, paths };
}
