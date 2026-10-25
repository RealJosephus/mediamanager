// Isolated ECMA-167 / UDF descriptors, without copyrighted media content.
// The layout can also be consumed by the reference DiscUtils UdfReader.
function crc16(bytes) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return value;
}

export function sealUdfDescriptor(bytes, identifier, location, bodyLength = bytes.length - 16) {
  bytes.writeUInt16LE(identifier, 0); bytes.writeUInt16LE(3, 2); bytes[4] = 0;
  bytes.writeUInt16LE(1, 6); bytes.writeUInt16LE(crc16(bytes.subarray(16, 16 + bodyLength)), 8);
  bytes.writeUInt16LE(bodyLength, 10); bytes.writeUInt32LE(location, 12);
  for (let i = 0; i < 16; i++) if (i !== 4) bytes[4] = (bytes[4] + bytes[i]) & 255;
  return bytes;
}

function longAd(bytes, offset, length, location, partition) {
  bytes.writeUInt32LE(length, offset); bytes.writeUInt32LE(location, offset + 4); bytes.writeUInt16LE(partition, offset + 8);
}

function fileEntry(blockSize, location, contentLength, { extended = false, allocation = 'short', partition = 0,
  embedded, parts = [{ location: 2, length: contentLength }], type = 4 } = {}) {
  const bytes = Buffer.alloc(blockSize), start = extended ? 216 : 176;
  bytes.writeUInt16LE(4, 20); bytes[27] = type; bytes.writeUInt16LE(1, 48);
  bytes.writeUInt16LE(allocation === 'embedded' ? 3 : allocation === 'long' ? 1 : 0, 34);
  bytes.writeBigUInt64LE(BigInt(contentLength), 56);
  if (extended) bytes.writeBigUInt64LE(BigInt(contentLength), 64);
  // Valid descriptor timestamps; the classifier does not interpret them.
  for (const offset of extended ? [80, 92, 104, 116] : [72, 84, 96]) {
    bytes.writeUInt16LE(0x1000, offset); bytes.writeUInt16LE(2026, offset + 2); bytes[offset + 4] = 1; bytes[offset + 5] = 1;
  }
  if (allocation === 'embedded') {
    bytes.writeUInt32LE(embedded.length, start - 4); embedded.copy(bytes, start);
  } else {
    const width = allocation === 'long' ? 16 : 8;
    bytes.writeUInt32LE(parts.length * width, start - 4);
    for (let i = 0; i < parts.length; i++) {
      bytes.writeUInt32LE(parts[i].length, start + i * width); bytes.writeUInt32LE(parts[i].location, start + i * width + 4);
      if (width === 16) bytes.writeUInt16LE(partition, start + i * width + 8);
    }
  }
  return sealUdfDescriptor(bytes, extended ? 266 : 261, location, start - 16 + bytes.readUInt32LE(start - 4));
}

/** Build a standalone UDF image containing only a root directory and empty children. */
export function makeUdfImage({ discType = 'Dvd', metadata = false, sectorSize = 2048,
  allocation = 'short', extended = false, split = false, entries = undefined } = {}) {
  const blockSize = sectorSize, partitionStart = 300, partitionLength = 64;
  const bytes = Buffer.alloc((partitionStart + partitionLength) * sectorSize);
  for (const [i, name] of ['BEA01', metadata ? 'NSR03' : 'NSR02', 'TEA01'].entries()) {
    bytes.write(name, 0x8000 + i * 2048 + 1, 'ascii'); bytes[0x8000 + i * 2048 + 6] = 1;
  }
  const sector = index => bytes.subarray(index * sectorSize, (index + 1) * sectorSize);
  const anchor = sector(256); anchor.writeUInt32LE(3 * sectorSize, 16); anchor.writeUInt32LE(257, 20);
  sealUdfDescriptor(anchor, 2, 256);
  const partition = sector(257); partition.writeUInt16LE(1, 20); partition.writeUInt16LE(0, 22);
  partition.write('+NSR02', 25, 'ascii'); partition.writeUInt32LE(1, 184);
  partition.writeUInt32LE(partitionStart, 188); partition.writeUInt32LE(partitionLength, 192);
  sealUdfDescriptor(partition, 5, 257);
  const volume = sector(258); volume.writeUInt32LE(blockSize, 212);
  volume[20] = 0; volume.write('OSTA Compressed Unicode', 21, 'ascii');
  volume.write('*OSTA UDF Compliant', 217, 'ascii'); volume.writeUInt16LE(metadata ? 0x250 : 0x102, 240);
  longAd(volume, 248, blockSize, 0, metadata ? 1 : 0);
  volume.writeUInt32LE(metadata ? 70 : 6, 264); volume.writeUInt32LE(metadata ? 2 : 1, 268);
  volume[440] = 1; volume[441] = 6; volume.writeUInt16LE(1, 442); volume.writeUInt16LE(0, 444);
  if (metadata) {
    volume[446] = 2; volume[447] = 64; volume.write('*UDF Metadata Partition', 451, 'ascii');
    volume.writeUInt16LE(1, 482); volume.writeUInt16LE(0, 484); volume.writeUInt32LE(1, 486);
    volume.writeUInt32LE(0xffffffff, 490); volume.writeUInt32LE(0xffffffff, 494);
    volume.writeUInt32LE(1, 498); volume.writeUInt16LE(1, 502);
  }
  sealUdfDescriptor(volume, 6, 258); sealUdfDescriptor(sector(259), 8, 259);
  const contentBase = partitionStart + (metadata ? 4 : 0), rootPartition = metadata ? 1 : 0;
  if (metadata) fileEntry(blockSize, 1, 32 * blockSize, { extended: true, type: 250,
    parts: [{ location: 4, length: 32 * blockSize }] }).copy(sector(partitionStart + 1));
  const fileSet = sector(contentBase); fileSet[48] = 0; fileSet.write('OSTA Compressed Unicode', 49, 'ascii');
  longAd(fileSet, 400, blockSize, 1, rootPartition); sealUdfDescriptor(fileSet, 256, 0);
  entries ??= discType === null ? [{ name: 'Other' }] : [{ name: discType === 'BluRay' ? 'BDMV' : 'VIDEO_TS' }];
  let directoryOffset = 0;
  const identifiers = entries.map((entry, i) => {
    const encoded = entry.utf16 ? Buffer.concat([Buffer.from([16]), Buffer.from(entry.name, 'utf16le').swap16()])
      : Buffer.concat([Buffer.from([8]), Buffer.from(entry.name, 'latin1')]);
    const fid = Buffer.alloc(Math.ceil((38 + encoded.length) / 4) * 4);
    fid.writeUInt16LE(1, 16); fid[18] = (entry.directory === false ? 0 : 2) | (entry.deleted ? 4 : 0) | (entry.parent ? 8 : 0);
    fid[19] = encoded.length; longAd(fid, 20, blockSize, 8 + i, rootPartition); encoded.copy(fid, 38);
    fileEntry(blockSize, 8 + i, 0, { allocation: 'embedded', embedded: Buffer.alloc(0), type: entry.directory === false ? 5 : 4 }).copy(sector(contentBase + 8 + i));
    const block = allocation === 'embedded' ? 1 : directoryOffset < blockSize || !split ? 2 : 5;
    directoryOffset += fid.length;
    return sealUdfDescriptor(fid, 257, block);
  });
  const content = Buffer.concat(identifiers), firstLength = split ? blockSize : content.length;
  if (split && content.length <= blockSize) throw new TypeError('Split UDF fixture content must exceed one logical block.');
  const parts = [{ location: 2, length: firstLength }, ...(split ? [{ location: 5, length: content.length - firstLength }] : [])];
  fileEntry(blockSize, 1, content.length, { extended, allocation, partition: rootPartition, embedded: content, parts }).copy(sector(contentBase + 1));
  if (allocation !== 'embedded') {
    content.subarray(0, firstLength).copy(sector(contentBase + 2));
    if (split) content.subarray(firstLength).copy(sector(contentBase + 5));
  }
  return bytes;
}
