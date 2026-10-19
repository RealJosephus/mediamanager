// CodePagesEncodingProvider mappings that WHATWG/ICU deliberately does not
// expose.  The strings are the pinned .NET decoder's byte 0x80..0xff table.
const singleByteHigh = Object.freeze({
  ibm850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  ibm852: 'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ ',
  ibm855: 'ђЂѓЃёЁєЄѕЅіІїЇјЈљЉњЊћЋќЌўЎџЏюЮъЪаАбБцЦдДеЕфФгГ«»░▒▓│┤хХиИ╣║╗╝йЙ┐└┴┬├─┼кК╚╔╩╦╠═╬¤лЛмМнНоОп┘┌█▄Пя▀ЯрРсСтТуУжЖвВьЬ№­ыЫзЗшШэЭщЩчЧ§■ ',
  'x-mac-ce': 'ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅņŃ¬√ńŇ∆«»… ňŐÕőŌ–—“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ',
});
const singleByteCharacters = new Map(Object.entries(singleByteHigh).map(([name, value]) => [name, [...value]]));

function utf32(bytes, littleEndian, offset = 0) {
  let result = '';
  for (let index = offset; index < bytes.length; index += 4) {
    if (index + 4 > bytes.length) { result += '\ufffd'; break; }
    const scalar = littleEndian ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index);
    result += scalar > 0x10ffff || scalar >= 0xd800 && scalar <= 0xdfff ? '\ufffd' : String.fromCodePoint(scalar);
  }
  return result;
}

function singleByte(bytes, table) {
  let result = '';
  for (const byte of bytes) result += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
  return result;
}

function hzGb2312(bytes) {
  let result = '', shifted = false;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index++];
    if (byte === 0x7e) {
      const next = bytes[index++];
      if (next === 0x7b) { shifted = true; continue; }
      if (next === 0x7d) { shifted = false; continue; }
      if (next === 0x7e) { result += '~'; continue; }
      if (next === 0x0a) continue;
      if (next === 0x0d && bytes[index] === 0x0a) { index++; continue; }
      result += '\ufffd';
      if (next === undefined) break;
      continue;
    }
    if (!shifted) { result += byte < 0x80 ? String.fromCharCode(byte) : '\ufffd'; continue; }
    const next = bytes[index++];
    if (next === undefined) { result += '\ufffd'; break; }
    if (byte < 0x21 || byte > 0x7e || next < 0x21 || next > 0x7e) { result += '\ufffd'; continue; }
    result += new TextDecoder('gb18030').decode(Uint8Array.of(byte | 0x80, next | 0x80));
  }
  return result;
}

function iso2022(bytes, { designation, decoder }) {
  let result = '', shifted = false, designated = false;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index++];
    if (byte === 0x1b) {
      const sequence = bytes.subarray(index, index + designation.length);
      if (sequence.length === designation.length && sequence.every((value, offset) => value === designation[offset])) {
        designated = true; index += designation.length; continue;
      }
      result += '\ufffd'; continue;
    }
    if (byte === 0x0e) { shifted = true; continue; }
    if (byte === 0x0f) { shifted = false; continue; }
    if (!shifted) { result += byte < 0x80 ? String.fromCharCode(byte) : '\ufffd'; continue; }
    const next = bytes[index++];
    if (!designated || next === undefined || byte < 0x21 || byte > 0x7e || next < 0x21 || next > 0x7e) {
      result += '\ufffd'; continue;
    }
    result += new TextDecoder(decoder).decode(Uint8Array.of(byte | 0x80, next | 0x80));
  }
  return result;
}

function bom(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) return ['utf-32le', 4];
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) return ['utf-32be', 4];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return ['utf-8', 3];
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return ['utf-16le', 2];
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return ['utf-16be', 2];
  return null;
}

/** Decode with StreamReader's BOM override and the pinned .NET code-page set. */
export function decodeNativeTextEncoding(bytes, encoding = 'utf-8') {
  const value = Buffer.from(bytes), marker = bom(value);
  if (marker) {
    const [name, offset] = marker;
    if (name === 'utf-32le' || name === 'utf-32be') return utf32(value, name === 'utf-32le', offset);
    return new TextDecoder(name).decode(value);
  }
  const name = String(encoding).toLowerCase();
  if (name === 'utf-32' || name === 'utf-32le') return utf32(value, true);
  if (name === 'utf-32be') return utf32(value, false);
  if (singleByteCharacters.has(name)) return singleByte(value, singleByteCharacters.get(name));
  if (name === 'hz-gb-2312') return hzGb2312(value);
  if (name === 'iso-2022-kr') return iso2022(value, { designation: Uint8Array.of(0x24, 0x29, 0x43), decoder: 'euc-kr' });
  if (name === 'x-cp50227') return value.includes(0x1b) || value.includes(0x0e) || value.includes(0x0f)
    ? iso2022(value, { designation: Uint8Array.of(0x24, 0x29, 0x41), decoder: 'gb18030' })
    : new TextDecoder('gb18030').decode(value);
  return new TextDecoder(encoding).decode(value);
}

// StreamReader and File.ReadAllText default to UTF-8 while still allowing a
// BOM to select UTF-16/UTF-32. XML declarations cannot override the TextReader.
export function decodeNativeText(bytes) { return decodeNativeTextEncoding(bytes, 'utf-8'); }
