import { detectNativeCharset } from '../core/native-charset.js';
import { decodeNativeTextEncoding } from '../core/native-text.js';

/** Normalize recognized external text without changing its stored source. */
export function normalizeSubtitleBytes(input) {
  const bytes = Buffer.from(input);
  const detected = detectNativeCharset(bytes, { stream: true }).details?.[0];
  // Subtitle delivery uses the first detector result without a confidence
  // threshold. UTF-8/ASCII and no-result inputs retain their original bytes.
  if (!detected || ['ascii', 'us-ascii', 'utf-8'].includes(detected.name.toLowerCase())) {
    return bytes;
  }
  return Buffer.from(decodeNativeTextEncoding(bytes, detected.encoding ?? 'utf-8'));
}

export function decodeSubtitleBytes(input) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(normalizeSubtitleBytes(input));
}
