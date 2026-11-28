import path from 'node:path';

const textCodecs = new Set(['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'sami']);
const readerFormats = new Set(['srt', 'vtt', 'ass', 'ssa', 'smi']);
const copyMuxers = new Map([
  ['ass', 'ass'], ['ssa', 'ass'], ['srt', 'srt'], ['subrip', 'srt'], ['pgssub', 'sup'],
]);

export const isVobSubFormat = format => /dvdsub|vobsub/i.test(format ?? '');
export const isPgsFormat = format => /pgs|^sup$/i.test(format ?? '');

export function subtitleExtractionFormat(stream) {
  const codec = stream.Codec?.toLowerCase();
  const muxer = copyMuxers.get(codec);
  if (muxer) return [muxer === 'srt' ? 'srt' : stream.Codec, muxer];
  if (isVobSubFormat(codec)) return ['mks', 'matroska'];
  if (stream.IsTextSubtitleStream === true && (!stream.IsExternal || /\.mks$/iu.test(stream.Path ?? ''))) {
    return ['srt', 'srt', 'srt'];
  }
}

export function subtitleInputFormat(stream) {
  const format = path.win32.extname(stream.Path ?? '').slice(1).toLowerCase() || stream.Codec?.toLowerCase();
  return ({ subrip: 'srt', webvtt: 'vtt', hdmv_pgs_subtitle: 'pgssub', sup: 'pgssub' })[format] ?? format;
}

export function subtitleExtensionHint(stream) {
  let filename = stream.Path ?? '';
  if (/^https?:\/\//iu.test(filename)) filename = new URL(filename).pathname;
  const extension = path.win32.extname(filename).toLowerCase();
  return ['.smi', '.sami', '.srt', '.subrip', '.ass', '.ssa', '.vtt', '.webvtt'].includes(extension) ? extension : undefined;
}

export function isExternalSubtitleFallback(stream) {
  if (stream?.Type !== 'Subtitle' || stream.IsExternal !== true || !textCodecs.has(stream.Codec?.toLowerCase())) return false;
  if (/^https?:\/\//iu.test(stream.Path ?? '')) {
    // Native applies Path.GetExtension to the original identity string. A query
    // suffix can therefore make even an SRT require the text-to-SRT fallback.
    return !readerFormats.has(subtitleInputFormat(stream));
  }
  return stream.Codec.toLowerCase() === 'sami' && /\.sami$/iu.test(stream.Path ?? '')
    && (path.win32.isAbsolute(stream.Path) || path.posix.isAbsolute(stream.Path));
}
