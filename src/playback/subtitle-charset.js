import { detect } from 'jschardet';
import { decodeNativeTextEncoding } from '../core/native-text.js';

const labels = Object.freeze({
  'utf-8-sig': 'utf-8', 'utf-16-le': 'utf-16le', 'utf-16-be': 'utf-16be',
  'utf-32-le': 'utf-32le', 'utf-32-be': 'utf-32be',
  cp874: 'windows-874', cp932: 'shift_jis', cp949: 'euc-kr',
  cp850: 'ibm850', cp852: 'ibm852', cp855: 'ibm855',
  big5hkscs: 'big5', 'mac-cyrillic': 'x-mac-cyrillic', maccyrillic: 'x-mac-cyrillic', 'mac-latin2': 'x-mac-ce',
});

/** Normalize recognized external text without changing its stored source. */
export function normalizeSubtitleBytes(input) {
  const bytes = Buffer.from(input);
  const marker = bytes.subarray(0, 4).toString('hex');
  if (marker.startsWith('fffe') || marker.startsWith('feff') || marker === '0000feff') {
    return Buffer.from(decodeNativeTextEncoding(bytes));
  }
  const detected = detect(bytes).encoding?.toLowerCase() ?? 'utf-8';
  const encoding = labels[detected] ?? detected;
  // UTF-8/ASCII and unmarked Unicode keep their raw delivery bytes. A format
  // conversion separately consumes that stream through its UTF-8 text reader.
  if (['ascii', 'us-ascii', 'utf-8', 'utf8'].includes(encoding) || /^utf-(?:16|32)/u.test(encoding)) {
    return bytes;
  }
  return Buffer.from(decodeNativeTextEncoding(bytes, encoding));
}

export function decodeSubtitleBytes(input) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(normalizeSubtitleBytes(input));
}
