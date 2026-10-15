import { readSync } from 'node:fs';

const invalid = () => Object.assign(new Error('Invalid Deflate64 data.'), { code: 'invalid-archive' });
const codeOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const counts = new Uint16Array(16), next = new Uint16Array(16), codes = Array.from({ length: 16 }, () => new Map());
  for (const length of lengths) { if (length > 15) throw invalid(); if (length) counts[length]++; }
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + counts[length - 1]) * 2;
    if (code + counts[length] > 2 ** length) throw invalid();
    next[length] = code;
  }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (length) codes[length].set(next[length]++, symbol);
  }
  return bits => {
    let value = 0;
    for (let length = 1; length <= 15; length++) {
      value = value * 2 + bits.read(1);
      const symbol = codes[length].get(value);
      if (symbol !== undefined) return symbol;
    }
    throw invalid();
  };
}
const fixedLiteral = huffman(Array.from({ length: 288 }, (_, symbol) => symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8));
const fixedDistance = huffman(new Array(32).fill(5));

/** Decode one selected ZIP entry using bounded input and a 64 KiB history window. */
export function readDeflate64(fd, start, compressedSize, expectedSize) {
  const input = Buffer.allocUnsafe(65536), window = Buffer.alloc(65536), chunks = [];
  let position = start, remaining = compressedSize, cursor = 0, available = 0, value = 0, bitCount = 0, written = 0;
  let chunk = Buffer.allocUnsafe(65536), chunkLength = 0;
  const bits = { read(count) {
    while (bitCount < count) {
      if (cursor === available) {
        if (!remaining) throw invalid();
        available = readSync(fd, input, 0, Math.min(input.length, remaining), position);
        if (!available) throw invalid();
        position += available; remaining -= available; cursor = 0;
      }
      value |= input[cursor++] << bitCount; bitCount += 8;
    }
    const result = value & (2 ** count - 1);
    value >>>= count; bitCount -= count;
    return result;
  } };
  const append = byte => {
    window[written & 65535] = byte; written++;
    chunk[chunkLength++] = byte;
    if (chunkLength === chunk.length) { chunks.push(chunk); chunk = Buffer.allocUnsafe(65536); chunkLength = 0; }
  };
  const finish = () => { if (chunkLength) chunks.push(chunk.subarray(0, chunkLength)); return Buffer.concat(chunks, written); };
  if (!expectedSize) return finish();
  let final;
  do {
    final = bits.read(1); const type = bits.read(2);
    if (type === 0) {
      value = 0; bitCount = 0;
      const length = bits.read(16), complement = bits.read(16);
      if ((length ^ complement) !== 65535) throw invalid();
      for (let index = 0; index < length; index++) {
        append(bits.read(8)); if (written === expectedSize) return finish();
      }
      continue;
    }
    if (type === 3) throw invalid();
    let literal = fixedLiteral, distance = fixedDistance;
    if (type === 2) {
      const literalCount = bits.read(5) + 257, distanceCount = bits.read(5) + 1, codeCount = bits.read(4) + 4;
      const codeLengths = new Array(19).fill(0);
      for (let index = 0; index < codeCount; index++) codeLengths[codeOrder[index]] = bits.read(3);
      const decode = huffman(codeLengths), lengths = [];
      while (lengths.length < literalCount + distanceCount) {
        const symbol = decode(bits);
        if (symbol < 16) lengths.push(symbol);
        else {
          if (symbol === 16 && !lengths.length) throw invalid();
          const count = symbol === 16 ? bits.read(2) + 3 : symbol === 17 ? bits.read(3) + 3 : bits.read(7) + 11;
          const length = symbol === 16 ? lengths.at(-1) : 0;
          if (lengths.length + count > literalCount + distanceCount) throw invalid();
          for (let index = 0; index < count; index++) lengths.push(length);
        }
      }
      if (!lengths[256]) throw invalid();
      literal = huffman(lengths.slice(0, literalCount)); distance = huffman(lengths.slice(literalCount));
    }
    while (true) {
      const symbol = literal(bits);
      if (symbol === 256) break;
      if (symbol < 256) append(symbol);
      else {
        if (symbol > 285) throw invalid();
        const index = symbol - 257, extra = index < 8 ? 0 : index === 28 ? 16 : (index - 4) >>> 2;
        const length = (index < 8 ? index + 3 : index === 28 ? 3 : (4 + (index & 3)) * 2 ** extra + 3) + bits.read(extra);
        const distanceCode = distance(bits), distanceExtra = Math.max(0, (distanceCode >>> 1) - 1);
        const offset = (distanceCode < 4 ? distanceCode + 1 : (2 + (distanceCode & 1)) * 2 ** distanceExtra + 1) + bits.read(distanceExtra);
        if (offset > Math.min(written, window.length)) throw invalid();
        for (let count = 0; count < length; count++) {
          append(window[(written - offset) & 65535]); if (written === expectedSize) return finish();
        }
      }
      if (written === expectedSize) return finish();
    }
  } while (!final);
  return finish();
}
