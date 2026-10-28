import { subtitleSamiBoundaryInput } from '../subtitle-sami-boundaries-current/input.js';

// Keep the original unmarked single-ç source intact. The other inputs declare
// different byte encodings of the same ordinary subtitle text.
const original = subtitleSamiBoundaryInput().sources.find(source => source.name === 'multiple-language-classes').text;
const changed = original.replace('English text', 'Changed English text');
const invalid = Buffer.from('Ordinary text without a subtitle document.\r\n');
const utf16 = (text, bigEndian) => {
  const payload = Buffer.from(text, 'utf16le');
  return Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), bigEndian ? payload.swap16() : payload]);
};
const request = (name, format, options = {}) => ({ name, op: 'request', format, ...options });
const action = (name, op, options = {}) => ({ name, op, ...options });
const entry = (name, source, suffix, actions, protocol = 'File', extension = '.sami') => ({
  name, source, extension, protocol, streamIndex: 0,
  mediaSourceId: `f8900000-0000-0000-0000-${suffix.padStart(12, '0')}`, actions,
});

export const nativeSourcePaths = [
  'MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs',
  'MediaBrowser.MediaEncoding/Subtitles/SubtitleEditParser.cs',
  'Emby.Server.Implementations/Library/PathManager.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs',
  'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
  'Emby.Server.Implementations/Configuration/ServerConfigurationManager.cs',
  'MediaBrowser.Controller/IO/LocalMediaProxy.cs',
  'MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs',
  'MediaBrowser.MediaEncoding/Encoder/EncodingUtils.cs',
  'MediaBrowser.MediaEncoding/Encoder/EncoderValidator.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
];

export function subtitleSamiFallbackInput() {
  return {
    schemaVersion: 1,
    modifiedUtc: '2025-01-02T03:04:05Z', changedModifiedUtc: '2025-01-03T03:04:05Z',
    sources: [
      { name: 'utf8-bom', base64: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original)]).toString('base64'),
        changedBase64: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(changed)]).toString('base64') },
      { name: 'unmarked-single-cedilla', base64: Buffer.from(original).toString('base64') },
      { name: 'utf16-le', base64: utf16(original, false).toString('base64') },
      { name: 'utf16-be', base64: utf16(original, true).toString('base64') },
      { name: 'invalid-text', base64: invalid.toString('base64') },
      { name: 'valid-cache-invalid-source', base64: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original)]).toString('base64'),
        changedBase64: invalid.toString('base64') },
    ],
    cases: [
      entry('file-cache-lifecycle', 'utf8-bom', '1', [
        request('cold-unsupported-sami', 'sami'),
        request('warm-srt', 'srt'), request('cold-srt', 'srt', { cold: true }),
        request('warm-vtt', 'vtt'), request('warm-json', 'json'),
        action('remove-meta', 'delete-meta'), request('missing-meta-srt', 'srt', { cold: true }),
        action('truncate-cache', 'empty-cache'), request('empty-cache-srt', 'srt', { cold: true }),
        action('change-source', 'write-source', { revision: 'changed' }), request('changed-source-srt', 'srt', { cold: true }),
        action('remove-source', 'delete-source'), request('missing-source-cached-srt', 'srt', { cold: true }),
        action('remove-orphan-meta', 'delete-meta'), request('missing-source-no-meta-srt', 'srt', { cold: true }),
        action('remove-orphan-cache', 'delete-cache'), request('missing-source-uncached-srt', 'srt', { cold: true }),
      ]),
      entry('file-unmarked-single-cedilla', 'unmarked-single-cedilla', '2', [request('cold-srt', 'srt'), request('warm-json', 'json')]),
      entry('file-utf16-le', 'utf16-le', '3', [request('cold-srt', 'srt'), request('warm-vtt', 'vtt')]),
      entry('file-utf16-be', 'utf16-be', '4', [request('cold-srt', 'srt'), request('warm-json', 'json')]),
      entry('file-upper-utf16-le', 'utf16-le', '5', [request('cold-srt', 'srt')], 'File', '.SAMI'),
      entry('file-upper-utf16-be', 'utf16-be', '6', [request('cold-srt', 'srt')], 'File', '.SAMI'),
      entry('file-invalid-input', 'invalid-text', '7', [request('cold-srt', 'srt'), request('cold-retry-srt', 'srt', { cold: true })]),
      entry('file-cancel-after-ffmpeg-read', 'utf8-bom', '8', [
        request('cancelled-srt', 'srt', { cancelAfterRead: true }), request('retry-srt', 'srt', { cold: true }),
      ]),
      entry('file-valid-cache-invalid-source', 'valid-cache-invalid-source', '10', [
        request('cold-valid-srt', 'srt'), action('change-source-to-invalid', 'write-source', { revision: 'changed' }),
        request('cold-invalid-source-srt', 'srt', { cold: true }), request('cold-invalid-source-retry-srt', 'srt', { cold: true }),
      ]),
      // These are independent Native observations. File identity and HTTP identity
      // support are separate capabilities in the production storage boundary.
      entry('http-cache-lifecycle', 'utf8-bom', '9', [
        request('cold-srt', 'srt'), action('remove-source', 'delete-source'),
        action('remove-meta', 'delete-meta'), request('missing-source-cached-srt', 'srt', { cold: true }),
        action('truncate-cache', 'empty-cache'), request('missing-source-empty-cache-srt', 'srt', { cold: true }),
      ], 'Http'),
    ],
  };
}
