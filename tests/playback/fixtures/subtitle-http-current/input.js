import { subtitleTextInput } from '../subtitle-text-current/input.js';
import { subtitleSamiFallbackInput } from '../subtitle-sami-fallback-current/input.js';

const bom = text => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]).toString('base64');
const raw = (name, options = {}) => ({ name, op: 'raw', method: 'GET', ...options });
const format = (name, value, options = {}) => ({ name, op: 'format', format: value, ...options });
const action = (name, op, options = {}) => ({ name, op, ...options });
const entry = (name, source, suffix, sourceTarget, actions, mediaProtocol = 'File') => ({ name, source, sourceTarget,
  mediaSourceId: `f8a00000-0000-0000-0000-${suffix.padStart(12, '0')}`, streamIndex: 0, mediaProtocol, actions });

export const nativeSourcePaths = [
  'Jellyfin.Api/Controllers/SubtitleController.cs', 'Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs', 'MediaBrowser.Controller/MediaEncoding/ISubtitleEncoder.cs',
  'MediaBrowser.Controller/Library/ILibraryManager.cs', 'MediaBrowser.Controller/Library/IMediaSourceManager.cs',
  'MediaBrowser.Controller/IO/LocalMediaProxy.cs', 'MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs',
  'MediaBrowser.MediaEncoding/Subtitles/SubtitleEditParser.cs', 'MediaBrowser.Model/Net/MimeTypes.cs',
  'Emby.Server.Implementations/IO/ManagedFileSystem.cs', 'Emby.Server.Implementations/Library/PathManager.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/Configuration/ServerConfigurationManager.cs',
  'MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs', 'MediaBrowser.MediaEncoding/Encoder/EncodingUtils.cs',
  'MediaBrowser.MediaEncoding/Encoder/EncoderValidator.cs',
  'MediaBrowser.Model/Dlna/StreamBuilder.cs', 'MediaBrowser.Model/Dlna/SubtitleProfile.cs',
  'MediaBrowser.Model/Entities/MediaStream.cs',
  'Jellyfin.Server/Startup.cs', 'Emby.Server.Implementations/ApplicationHost.cs',
  'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs', 'Jellyfin.Api/BaseJellyfinApiController.cs',
  'src/Jellyfin.Networking/HappyEyeballs/HttpClientExtension.cs',
];

export function subtitleHttpInput() {
  const text = subtitleTextInput(), sami = subtitleSamiFallbackInput();
  const srt = '1\r\n00:00:01,180 --> 00:00:04,250\r\nHTTP original 中文 and <i>markup</i>.\r\n\r\n';
  const ass = text.sources.find(source => source.name === 'ass-legacy').text;
  const samiBom = sami.sources.find(source => source.name === 'utf8-bom');
  return {
    schemaVersion: 1,
    profiles: ['subrip', 'sami', 'ass', 'ssa'].flatMap(codec => ['External', 'Hls'].flatMap(method =>
      ['DirectPlay', 'Transcode'].flatMap(playMethod => [...new Set([codec, 'srt', 'vtt', 'json', 'ass', 'ssa', 'ttml'])].map(candidate => ({
        name: `${codec}-${method}-${playMethod}-${candidate}`, codec, method, playMethod, candidate,
      }))))).concat(['External', 'Hls'].flatMap(method => ['DirectPlay', 'Transcode'].map(playMethod => ({
        name: `webvtt-${method}-${playMethod}-srt`, codec: 'webvtt', method, playMethod, candidate: 'srt',
      })))).concat(['ass', 'ssa'].flatMap(codec => ['External', 'Hls'].map(method => ({
        name: `${codec}-embedded-${method}-Transcode-vtt`, codec, method, playMethod: 'Transcode', candidate: 'vtt', external: false,
      })))),
    sources: [
      { name: 'srt-bom', extension: '.srt', codec: 'subrip', base64: bom(srt) },
      { name: 'ass-bom', extension: '.ass', codec: 'ass', base64: bom(ass) },
      { name: 'smi-bom', extension: '.smi', codec: 'sami', base64: samiBom.base64 },
      { name: 'smi-utf16-le', extension: '.smi', codec: 'sami', base64: sami.sources.find(source => source.name === 'utf16-le').base64 },
      { name: 'sami-bom', extension: '.sami', codec: 'sami', base64: samiBom.base64, changedBase64: samiBom.changedBase64 },
    ],
    cases: [
      entry('http-srt-raw-and-format', 'srt-bom', '1', '/source/plain.srt', [
        raw('raw-get'), raw('raw-head', { method: 'HEAD' }),
        raw('raw-range', { headers: { Range: 'bytes=4-23' } }), raw('raw-suffix', { headers: { Range: 'bytes=-17' } }),
        raw('raw-if-range-match', { headers: { Range: 'bytes=4-23', 'If-Range': '"owned-original"' } }),
        raw('raw-if-range-mismatch', { headers: { Range: 'bytes=4-23', 'If-Range': '"different-version"' } }),
        raw('raw-unsatisfiable', { headers: { Range: 'bytes=99999-' } }),
        format('same-srt', 'srt'), format('converted-vtt', 'vtt'), format('converted-json', 'json'),
        action('ignore-upstream-range', 'source-mode', { mode: 'ignore-range' }), raw('ignored-range', { headers: { Range: 'bytes=4-23' } }),
        action('upstream-forbidden', 'source-mode', { mode: '403' }), raw('raw-403'), format('format-403', 'vtt'),
        action('upstream-not-found', 'source-mode', { mode: '404' }), raw('raw-404'), format('format-404', 'vtt'),
        action('upstream-redirect', 'source-mode', { mode: 'redirect' }), raw('raw-redirect'), format('format-redirect', 'vtt'),
        action('upstream-gzip', 'source-mode', { mode: 'gzip' }), raw('raw-gzip'), raw('head-gzip', { method: 'HEAD' }), format('format-gzip', 'vtt'),
        action('upstream-chunked', 'source-mode', { mode: 'chunked' }), raw('raw-chunked'), raw('head-chunked', { method: 'HEAD' }), format('format-chunked', 'vtt'),
      ]),
      entry('http-ass-original-and-format', 'ass-bom', '2', '/source/original.ass', [raw('raw-get'), format('same-ass', 'ass'), format('vtt', 'vtt'), format('json', 'json')], 'Http'),
      entry('http-smi-original-and-format', 'smi-bom', '3', '/source/original.smi', [raw('raw-get'), format('same-smi', 'smi'), format('srt', 'srt'), format('vtt', 'vtt')]),
      entry('http-smi-utf16', 'smi-utf16-le', '4', '/source/utf16.smi', [raw('raw-get'), format('same-smi', 'smi'), format('srt', 'srt')]),
      entry('http-srt-query-percent', 'srt-bom', '5', '/source/subtitle%20name.srt?signature=a%2Fb%2Bc&literal=%252F', [raw('raw-get'), format('srt', 'srt'), format('vtt', 'vtt')]),
      entry('http-sami-query-percent', 'sami-bom', '6', '/source/caption%20name.sami?signature=a%2Fb%2Bc&literal=%252F', [raw('raw-get'), format('srt', 'srt'), format('vtt', 'vtt')]),
      entry('http-sami-cache-lifecycle', 'sami-bom', '7', '/source/cache.sami', [
        format('cold-sami', 'sami'), format('warm-srt', 'srt'), format('cold-srt', 'srt', { cold: true }),
        action('seed-preexisting-meta', 'seed-cache', { metaBase64: Buffer.from('Preexisting HTTP cache metadata\r\n').toString('base64') }),
        format('preexisting-meta-srt', 'srt', { cold: true }),
        action('change-upstream', 'write-source', { revision: 'changed' }), format('changed-upstream-cached-srt', 'srt', { cold: true }),
        action('upstream-offline', 'source-mode', { mode: 'offline' }), format('offline-cached-srt', 'srt', { cold: true }),
        action('remove-meta', 'delete-meta'), format('offline-no-meta-srt', 'srt', { cold: true }),
        action('truncate-offline-cache', 'empty-cache'), format('offline-empty-cache-srt', 'srt', { cold: true }),
        action('upstream-online', 'source-mode', { mode: 'online' }), action('truncate-online-cache', 'empty-cache'),
        format('online-empty-cache-srt', 'srt', { cold: true }), format('new-cache-vtt', 'vtt'),
      ]),
      entry('http-preexisting-nonempty-no-meta', 'sami-bom', '8', '/source/seeded.sami', [
        action('seed-cache', 'seed-cache', { cacheBase64: bom(srt) }), format('cold-seeded-srt', 'srt', { cold: true }),
        action('take-source-offline', 'source-mode', { mode: 'offline' }), format('offline-seeded-vtt', 'vtt', { cold: true }),
      ]),
      entry('http-raw-stream-cancel', 'srt-bom', '9', '/source/raw-cancel.srt', [raw('cancel-stream', { cancelAfterBytes: 12 }), raw('retry-raw')]),
      entry('http-charset-cancel', 'sami-bom', '10', '/source/charset-cancel.sami', [format('cancel-charset', 'srt', { cancelAt: 'charset' }), format('retry-srt', 'srt', { cold: true })]),
      entry('http-ffmpeg-cancel', 'sami-bom', '11', '/source/ffmpeg-cancel.sami', [format('cancel-ffmpeg', 'srt', { cancelAt: 'ffmpeg' }), format('retry-srt', 'srt', { cold: true })]),
      entry('http-controller-disconnect', 'sami-bom', '12', '/source/controller-disconnect.sami', [
        format('disconnect-after-ffmpeg-read', 'srt', { clientDisconnectAfterRead: true }), format('cold-after-disconnect-srt', 'srt', { cold: true }),
      ]),
    ],
  };
}
