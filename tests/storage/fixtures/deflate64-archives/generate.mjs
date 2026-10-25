// Independent ZIP/Deflate64 bit encoder. Native .NET, rather than this encoder,
// supplies every permanent expected read result. No production code is imported.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const root = new URL('.', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
class Bits {
  bytes = []; value = 0; count = 0;
  write(value, width) {
    for (let index = 0; index < width; index++) {
      this.value |= (value >>> index & 1) << this.count;
      if (++this.count === 8) { this.bytes.push(this.value); this.value = 0; this.count = 0; }
    }
  }
  align() { if (this.count) { this.bytes.push(this.value); this.value = 0; this.count = 0; } }
  finish() { this.align(); return Buffer.from(this.bytes); }
}
function codes(lengths) {
  const counts = new Array(16).fill(0), next = new Array(16).fill(0);
  for (const length of lengths) if (length) counts[length]++;
  let value = 0;
  for (let length = 1; length <= 15; length++) { value = (value + counts[length - 1]) * 2; next[length] = value; }
  const table = lengths.map(length => length ? { value: next[length]++, width: length } : null);
  return (bits, symbol) => {
    const code = table[symbol]; if (!code) throw Error('Absent encoder symbol: ' + symbol);
    // Huffman codes are emitted most significant bit first.
    for (let index = code.width - 1; index >= 0; index--) bits.write(code.value >>> index & 1, 1);
  };
}
const fixedLiteral = codes(Array.from({ length: 288 }, (_, index) => index < 144 ? 8 : index < 256 ? 9 : index < 280 ? 7 : 8));
const fixedDistance = codes(new Array(32).fill(5));
const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
class Entry {
  bits = new Bits(); output = [];
  stored(bytes, final = false) {
    if (bytes.length > 65535) throw Error('Stored block too large');
    this.bits.write(Number(final), 1); this.bits.write(0, 2); this.bits.align();
    this.bits.write(bytes.length, 16); this.bits.write(bytes.length ^ 65535, 16);
    for (const byte of bytes) { this.bits.write(byte, 8); this.output.push(byte); }
  }
  tokens(tokens, literal, distance) {
    for (const token of tokens) {
      if (typeof token === 'object' && 'lengthSymbol' in token) {
        literal(this.bits, token.lengthSymbol); this.bits.write(token.lengthExtra, token.lengthWidth);
        distance(this.bits, token.distanceSymbol); this.bits.write(token.distanceExtra, token.distanceWidth);
        if (token.expectedDistance > this.output.length) throw Error('Independent expected history underflow');
        for (let count = 0; count < token.expectedLength; count++) this.output.push(this.output[this.output.length - token.expectedDistance]);
      } else for (const byte of typeof token === 'string' ? Buffer.from(token) : token) { literal(this.bits, byte); this.output.push(byte); }
    }
    literal(this.bits, 256);
  }
  fixed(tokens, final = true) {
    this.bits.write(Number(final), 1); this.bits.write(1, 2);
    this.tokens(tokens, fixedLiteral, fixedDistance);
  }
  dynamic(tokens, { sparse = false, final = true } = {}) {
    const literalLengths = sparse ? new Array(286).fill(0) : Array.from({ length: 286 }, (_, index) => index < 226 ? 8 : 9);
    const distanceLengths = sparse ? new Array(32).fill(0) : new Array(32).fill(5);
    if (sparse) { for (const symbol of [65, 70, 256, 285]) literalLengths[symbol] = 2; distanceLengths[0] = distanceLengths[31] = 1; }
    const lengthLengths = Array.from({ length: 19 }, (_, index) => index < 13 ? 4 : 5), emitLength = codes(lengthLengths);
    this.bits.write(Number(final), 1); this.bits.write(2, 2);
    this.bits.write(29, 5); this.bits.write(31, 5); this.bits.write(15, 4);
    for (const symbol of order) this.bits.write(lengthLengths[symbol], 3);
    const lengths = [...literalLengths, ...distanceLengths];
    for (let index = 0; index < lengths.length;) {
      const value = lengths[index]; let count = 1;
      while (index + count < lengths.length && lengths[index + count] === value) count++;
      index += count;
      if (!value) {
        while (count >= 11) { const part = Math.min(138, count); emitLength(this.bits, 18); this.bits.write(part - 11, 7); count -= part; }
        if (count >= 3) { emitLength(this.bits, 17); this.bits.write(count - 3, 3); count = 0; }
        while (count--) emitLength(this.bits, 0);
      } else {
        emitLength(this.bits, value); count--;
        while (count >= 3) { const part = Math.min(6, count); emitLength(this.bits, 16); this.bits.write(part - 3, 2); count -= part; }
        while (count--) emitLength(this.bits, value);
      }
    }
    this.tokens(tokens, codes(literalLengths), codes(distanceLengths));
  }
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; return value >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crc >>> 8 ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const locals = [], centrals = []; let offset = 0, directorySize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.output), compressed = entry.compressed ?? entry.bits.finish();
    const local = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(bytes);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(21, 4); local.writeUInt16LE(entry.method ?? 9, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(21, 4); central.writeUInt16LE(21, 6); central.writeUInt16LE(entry.method ?? 9, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); centrals.push(central, name); offset += local.length + name.length + compressed.length; directorySize += central.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
const entries = [], descriptions = [];
function add(name, description, encode) {
  const entry = new Entry(); entry.name = name; encode(entry); entries.push(entry);
  descriptions.push({ name, description, generatedLength: entry.output.length, generatedSha256: digest(Buffer.from(entry.output)) });
}
const seed = length => Buffer.from(Array.from({ length }, (_, index) => (index * 73 + (index >>> 8) * 19 + 31) & 255));
const match = (expectedLength, expectedDistance, { lengthExtra = expectedLength - 3, distanceSymbol = 0, distanceExtra = 0, distanceWidth = 0 } = {}) => ({
  lengthSymbol: 285, lengthExtra, lengthWidth: 16, distanceSymbol, distanceExtra, distanceWidth, expectedLength, expectedDistance,
});
add('stored-65535-then-stored', 'Stored LEN/NLEN at maximum and a second stored block crossing the 64 KiB input buffer.', entry => { entry.stored(seed(65535)); entry.stored(Buffer.from('tail'), true); });
add('fixed-all-literals', 'All 256 fixed alphabet literals, including nine-bit codes.', entry => entry.fixed([seed(1024)]));
for (const length of [3, 258, 259, 65538]) add('fixed-code285-length-' + length, 'Deflate64 code 285 with sixteen length bits: ' + length + '.', entry => entry.fixed(['A', match(length, 1)]));
for (const [distance, code, extra, width] of [[32768, 29, 8191, 13], [32769, 30, 0, 14], [49152, 30, 16383, 14], [49153, 31, 0, 14], [65535, 31, 16382, 14], [65536, 31, 16383, 14]]) {
  add('fixed-distance-' + distance, 'Stored history followed by fixed code 285 and distance ' + distance + '.', entry => {
    const prefix = seed(distance); entry.stored(prefix.subarray(0, Math.min(65535, distance)));
    entry.fixed([prefix.subarray(65535), match(19, distance, { distanceSymbol: code, distanceExtra: extra, distanceWidth: width })]);
  });
}
add('window-wrap-distance65536-longmatch', 'History wraps twice; a maximum code285 match overlaps at distance65536.', entry => {
  const prefix = seed(131072); entry.stored(prefix.subarray(0, 65535)); entry.stored(prefix.subarray(65535, 131070));
  entry.fixed([prefix.subarray(131070), match(65538, 65536, { distanceSymbol: 31, distanceExtra: 16383, distanceWidth: 14 })]);
});
add('dynamic-complete-length-repeat16', 'Complete dynamic literal/distance trees with code-length repeat16 and a maximum code285 overlap.', entry => entry.dynamic(['A', match(65538, 1)]));
add('dynamic-sparse-repeat17-18', 'Sparse complete literal tree and two-code distance tree; zero repeats17/18.', entry => entry.dynamic(['AFAF', match(259, 1)], { sparse: true }));
add('dynamic-distance65536', 'Maximum Deflate64 distance31 through the dynamic Huffman alphabet.', entry => {
  entry.stored(seed(65535)); entry.dynamic(['A', match(65538, 65536, { distanceSymbol: 31, distanceExtra: 16383, distanceWidth: 14 })]);
});
add('stored-fixed-dynamic-stored-fixed', 'Five block transitions preserve bit alignment and history across all block modes.', entry => {
  entry.stored(Buffer.from('begin:')); entry.fixed(['ABC', match(6, 1)], false);
  entry.dynamic(['xyz', match(13, 1)], { final: false }); entry.stored(Buffer.from(':stored:')); entry.fixed(['end', match(8, 1)]);
});
await fs.mkdir(new URL('assets/', root), { recursive: true });
await fs.writeFile(new URL('assets/generated-boundaries.zip', root), zip(entries), { flag: 'wx' });
for (const method of [8, 9, 12, 14, 93, 95, 98]) {
  const bytes = Buffer.from('A');
  await fs.writeFile(new URL('assets/method-' + method + '.zip', root), zip([{ name: 'a', output: bytes, compressed: deflateRawSync(bytes), method }]), { flag: 'wx' });
}
await fs.writeFile(new URL('generated-inputs.json', root), JSON.stringify({ scope: 'Independent bit-encoder inputs and intended plaintext; native execution must confirm every value before these can be expected results.', entries: descriptions }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ generatedEntries: entries.length }));
