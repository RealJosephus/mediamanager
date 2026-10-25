import { EOL } from 'node:os';
import { XMLParser } from 'fast-xml-parser';

const entities = new XMLParser({ parseTagValue: false, trimValues: false, processEntities: true, htmlEntities: true });
entities.addEntity('alpha', '\u03B1');
entities.addEntity('rarr', '\u2192');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function decodeText(value) {
  // Decode dialogue, preserving entity spelling inside formatting attributes.
  const plain = part => String(entities.parse('<text>' + part.replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</text>').text ?? '');
  if (!value.includes('<') || !value.includes('>')) return plain(value);
  // The public SAMI reader limits formatted text before decoding its entities.
  return value.slice(0, 999).split(/(<(?:font|div|i|b|s)[^>]*>|<\/[^>]*>)/gu)
    .map((part, index) => index % 2 ? part : plain(part)).join('');
}

function samiText(value) {
  // A source paragraph is discarded before the following translated paragraph.
  value = value.replace(/<[pP]\b[^>]*\bID=(?:"Source"|Source)[^>]*>[\s\S]*?(?=<\/[pP]>|<[pP]>)/u, '');
  value = value.replace(/\r\n|\r|\n/gu, ' ').trimEnd()
    .replace(/<br {0,2}\/?>/giu, EOL).replace(/ {2,}/gu, ' ')
    .replace(/<\/(?:BODY|SAMI|body|sami)>/gu, '').trimEnd();
  const firstEnd = value.indexOf('>'), syncEnd = value.toLowerCase().indexOf('</sync>');
  if (firstEnd > 0 && (syncEnd < 0 || firstEnd < syncEnd)) value = value.slice(firstEnd + 1);
  value = value.trimEnd().replace(/<\/sync>$/iu, '').trimEnd().replace(/<\/p>$/iu, '').trimEnd()
    .replaceAll('&nbsp;', ' ').replaceAll('&NBSP;', ' ')
    .replace(/<\/(?:p|sync|body)>/gu, '');
  if (value.includes('<font color=') && !value.includes('</font>')) value += '</font>';
  if (value.startsWith('<FONT COLOR=') && !value.includes('</font>') && !value.includes('</FONT>')) value += '</FONT>';
  // Numeric NBSP references become ordinary spaces after dialogue whitespace
  // processing, so their distinct spacing remains visible in the public text.
  return decodeText(value).replace(/ {2,}/gu, ' ').replace(/ *(\r\n|\r|\n) */gu, '$1').trim()
    .replaceAll('\u00A0', ' ').replace(/\r\n|\r|\n/gu, EOL);
}

function finalCueDuration(text) {
  const visible = text.replace(/<\/?(?:[ibu]\/?|font\b[^>]*)>/giu, '');
  let count = 0;
  for (const { segment } of graphemes.segment(visible)) {
    // A CRLF line break contributes one duration unit in the public SAMI reader.
    if (segment === '\r\n' || !/^[\p{Cc}\u200B\uFEFF\u200E\u200F\u202A-\u202E]$/u.test(segment)) count++;
  }
  let milliseconds = count / 15 * 1000;
  if (milliseconds < 1400) milliseconds *= 1.2;
  else if (milliseconds < 1680) milliseconds = 1680;
  else if (milliseconds > 2900) milliseconds = Math.max(2900, milliseconds * 0.96);
  return BigInt(Math.trunc(Math.min(8000, Math.max(1000, milliseconds)) * 10000));
}

/** Read SAMI synchronization blocks into subtitle cue values. */
export function readSamiCues(text) {
  text = text.replaceAll('<SYNC Start= "', '<SYNC Start="').replaceAll('<SYNC Start = "', '<SYNC Start="')
    .replaceAll('<SYNC Start ="', '<SYNC Start="').replaceAll('<SYNC  Start="', '<SYNC Start="');
  const markerPattern = text.includes('<sync encrypted="true" start=')
    ? /<sync (?:encrypted="true" )?start=["']?(\d+)["']?[^>]*>/giu
    : /<sync start=["']?(\d+)["']?[^>]*>/giu;
  const markers = [...text.matchAll(markerPattern)];
  const cues = [];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index], next = markers[index + 1];
    const value = samiText(text.slice(marker.index + marker[0].length, next?.index ?? text.length));
    if (!value) continue;
    const start = BigInt(marker[1]) * 10000n;
    cues.push({ Id: String(cues.length + 1), Text: value,
      StartPositionTicks: start, EndPositionTicks: next ? BigInt(next[1]) * 10000n : start + finalCueDuration(value) });
  }
  return cues;
}
