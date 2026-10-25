// UDF root-directory reading derived from DiscUtils 0.16.13 (MIT).
// See resources/udf-disc-type-notice.txt for the exact source and license.
import { StorageError } from './errors.js';
import { ordinalIgnoreCaseEquals } from './ordinal-comparer.js';

const chunkSize = 64 * 1024;
const maximumEntrySize = 1024 * 1024;
const invalid = message => new StorageError('invalid-response', `Invalid UDF image: ${message}`);
const unsupported = message => new StorageError('not-supported', `Unsupported UDF image: ${message}`);
const abort = signal => signal?.throwIfAborted();

function bounds(offset, count, length) {
  if (offset < 0n || !Number.isSafeInteger(count) || count < 0 || offset + BigInt(count) > length) {
    throw invalid('A descriptor or extent exceeds its containing object.');
  }
}

function validTag(bytes) {
  if (bytes.length < 16 || bytes.readUInt16LE(0) === 0) return false;
  let checksum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) checksum += bytes[i];
  return (checksum & 255) === bytes[4];
}

function requireTag(bytes, identifier) {
  if (!validTag(bytes) || bytes.readUInt16LE(0) !== identifier) throw invalid('The descriptor tag is invalid.');
}

function longExtent(bytes, offset) {
  bounds(BigInt(offset), 16, BigInt(bytes.length));
  return { length: bytes.readUInt32LE(offset) & 0x3fffffff,
    block: bytes.readUInt32LE(offset + 4), partition: bytes.readUInt16LE(offset + 8) };
}

function nameFrom(bytes) {
  if (!bytes.length) return '';
  if (bytes[0] === 8) return bytes.subarray(1).toString('latin1');
  if (bytes[0] !== 16) throw invalid('The directory name compression identifier is invalid.');
  let name = '';
  for (let i = 1; i < bytes.length; i += 2) name += String.fromCharCode((bytes[i] << 8) | (bytes[i + 1] ?? 0));
  return name;
}

async function imageReader(vfs, path, { signal, version }) {
  abort(signal);
  const info = await vfs.stat(path, { signal });
  abort(signal);
  if (info.kind !== 'file' || info.size == null) throw invalid('A finite image file is required.');
  const size = BigInt(info.size), expectedVersion = version ?? info.version;
  const modifiedValue = value => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') { const time = Date.parse(value); if (Number.isFinite(time)) return time; }
    return value ?? null;
  };
  const expectedModified = modifiedValue(info.modified);
  if (size < 0n) throw invalid('The image size is invalid.');
  if (version != null && info.version !== version) throw new StorageError('version-changed', 'The UDF image changed before reading.');
  const sameVersion = actual => {
    if (expectedVersion != null && actual !== expectedVersion) throw new StorageError('version-changed', 'The UDF image changed during reading.');
  };
  return {
    size,
    async read(offset, count) {
      bounds(offset, count, size);
      abort(signal);
      if (!count) return Buffer.alloc(0);
      if (count > maximumEntrySize) throw unsupported('The descriptor exceeds the bounded metadata read size.');
      const result = Buffer.alloc(count);
      const handle = await vfs.openRead(path, { signal, range: { start: offset, end: offset + BigInt(count) - 1n },
        ifMatch: expectedVersion ?? undefined });
      let failure;
      try {
        abort(signal);
        sameVersion(handle.version);
        if (handle.totalSize != null && BigInt(handle.totalSize) !== size) throw new StorageError('version-changed', 'The UDF image size changed during reading.');
        if (expectedVersion == null && handle.modified != null && modifiedValue(handle.modified) !== expectedModified) {
          throw new StorageError('version-changed', 'The UDF image modification time changed during reading.');
        }
        if (handle.rangeHonored && (handle.range?.start == null || handle.range?.end == null
          || BigInt(handle.range.start) !== offset || BigInt(handle.range.end) !== offset + BigInt(count) - 1n)) {
          throw invalid('The storage read returned a different byte range.');
        }
        let skip = handle.rangeHonored ? 0n : offset, written = 0;
        for await (const value of handle.stream) {
          abort(signal);
          if (!(value instanceof Uint8Array)) throw invalid('The storage read did not return bytes.');
          const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          if (skip >= BigInt(bytes.length)) { skip -= BigInt(bytes.length); continue; }
          const start = Number(skip); skip = 0n;
          const length = Math.min(bytes.length - start, count - written);
          bytes.copy(result, written, start, start + length); written += length;
          if (written === count) break;
        }
        abort(signal);
        if (written !== count) throw invalid('The storage read ended before the requested bytes.');
        return result;
      } catch (error) { failure = error; abort(signal); throw error; }
      finally {
        try { await handle.close(); }
        catch (error) { if (!failure) throw error; }
      }
    },
    async finish() {
      abort(signal);
      const current = await vfs.stat(path, { signal });
      sameVersion(current.version);
      if (current.kind !== 'file' || current.size == null || BigInt(current.size) !== size) {
        throw new StorageError('version-changed', 'The UDF image changed during reading.');
      }
      if (expectedVersion == null && modifiedValue(current.modified) !== expectedModified) {
        throw new StorageError('version-changed', 'The UDF image modification time changed during reading.');
      }
      abort(signal);
    }
  };
}

async function classify(image, signal) {
  let recognized = false;
  for (let position = 0x8000n; position + 2048n <= image.size; position += 2048n) {
    const bytes = await image.read(position, 2048), identifier = bytes.toString('latin1', 1, 6);
    if (identifier === 'NSR02' || identifier === 'NSR03') { recognized = true; break; }
    else if (!['BEA01', 'BOOT2', 'CD001', 'CDW02', 'TEA01'].includes(identifier)) break;
  }
  if (!recognized) throw invalid('No UDF volume recognition sequence was found.');
  let sectorSize;
  for (const candidate of [2048, 512, 4096, 1024]) {
    if (image.size < 257n * BigInt(candidate)) continue;
    const tag = await image.read(256n * BigInt(candidate), 512);
    if (validTag(tag) && tag.readUInt16LE(0) === 2 && tag.readUInt32LE(12) === 256) { sectorSize = candidate; break; }
  }
  if (!sectorSize) throw invalid('The physical sector size could not be detected.');
  const sector = BigInt(sectorSize), anchor = await image.read(256n * sector, 512);
  const sequenceLength = anchor.readUInt32LE(16), sequenceStart = BigInt(anchor.readUInt32LE(20)) * sector;
  bounds(sequenceStart, sequenceLength, image.size);
  const physical = new Map();
  let volume;
  for (let offset = 0; offset + sectorSize <= sequenceLength; offset += sectorSize) {
    const bytes = await image.read(sequenceStart + BigInt(offset), sectorSize);
    if (!validTag(bytes)) break;
    const tag = bytes.readUInt16LE(0);
    if (tag === 8) break;
    if (tag === 5) {
      const number = bytes.readUInt16LE(22);
      if (physical.has(number)) throw invalid('The physical partition number is duplicated.');
      const start = BigInt(bytes.readUInt32LE(188)) * sector, size = BigInt(bytes.readUInt32LE(192)) * sector;
      if (start + size > image.size) throw invalid('The physical partition exceeds the image.');
      physical.set(number, { size, read: (offset, count) => { bounds(offset, count, size); return image.read(start + offset, count); } });
    } else if (tag === 6) volume = bytes;
  }
  if (!volume) throw invalid('The logical volume descriptor is missing.');
  const blockSize = volume.readUInt32LE(212), block = BigInt(blockSize);
  if (!blockSize) throw invalid('The logical block size is zero.');
  const mapLength = volume.readUInt32LE(264), mapCount = volume.readUInt32LE(268);
  bounds(440n, mapLength, BigInt(volume.length));
  const partitions = [];
  let mapOffset = 440;
  for (let i = 0; i < mapCount; i++) {
    bounds(BigInt(mapOffset), 2, BigInt(440 + mapLength));
    const type = volume[mapOffset], length = volume[mapOffset + 1];
    bounds(BigInt(mapOffset), length, BigInt(440 + mapLength));
    let partitionNumber, metadataLocation;
    if (type === 1 && length === 6) partitionNumber = volume.readUInt16LE(mapOffset + 4);
    else if (type === 2 && length === 64
      && volume.toString('latin1', mapOffset + 5, mapOffset + 28).replace(/\0+$/u, '') === '*UDF Metadata Partition') {
      partitionNumber = volume.readUInt16LE(mapOffset + 38);
      metadataLocation = volume.readUInt32LE(mapOffset + 40);
    } else throw unsupported('The logical partition map is not Type1 or Metadata.');
    const source = physical.get(partitionNumber);
    if (!source) throw invalid('The logical partition refers to a missing physical partition.');
    partitions.push(metadataLocation === undefined ? source : { source, metadataLocation });
    mapOffset += length;
  }
  if (!partitions.length || mapOffset !== 440 + mapLength) throw invalid('The partition map table length is invalid.');

  const partitionAt = number => {
    const value = partitions[number];
    if (!value) throw invalid('An extent refers to a missing logical partition.');
    return value;
  };
  const readPartition = async (partition, offset, count, active = new Set()) => {
    abort(signal);
    if (active.has(partition)) throw invalid('The metadata partition allocation contains a cycle.');
    if (!partition.file) return partition.read(offset, count);
    const next = new Set(active); next.add(partition);
    return readContent(partition.file, offset, count, next);
  };
  const readContent = async (file, offset, count, active = new Set()) => {
    bounds(offset, count, file.size);
    if (file.embedded) return Buffer.from(file.embedded.subarray(Number(offset), Number(offset) + count));
    const result = Buffer.alloc(count);
    let written = 0, position = 0n;
    for (const extent of file.extents) {
      const end = position + BigInt(extent.length);
      if (offset < end && written < count) {
        const within = offset > position ? offset - position : 0n;
        const length = Math.min(Number(end - position - within), count - written);
        const part = extent.partition === undefined ? file.partition : partitionAt(extent.partition);
        const bytes = await readPartition(part, BigInt(extent.block) * block + within, length, active);
        bytes.copy(result, written); written += length; offset += BigInt(length);
      }
      position = end;
      if (written === count) break;
    }
    if (written !== count) throw invalid('The file allocation is shorter than its information length.');
    return result;
  };
  const readEntry = async (partition, offset, length, metadata = false) => {
    if (length < 176 || length > maximumEntrySize) throw invalid('The file entry length is invalid.');
    const bytes = await readPartition(partition, offset, length);
    if (!validTag(bytes)) throw invalid('The file entry tag is invalid.');
    const tag = bytes.readUInt16LE(0), extended = tag === 266;
    if ((!extended && tag !== 261) || metadata && !extended) throw unsupported('The file entry descriptor type is not supported.');
    const header = extended ? 216 : 176;
    bounds(0n, header, BigInt(bytes.length));
    const size = bytes.readBigUInt64LE(56), allocationType = bytes.readUInt16LE(34) & 7;
    const extraLength = bytes.readUInt32LE(header - 8), allocationLength = bytes.readUInt32LE(header - 4);
    bounds(BigInt(header + extraLength), allocationLength, BigInt(bytes.length));
    const allocations = bytes.subarray(header + extraLength, header + extraLength + allocationLength);
    const file = { size, partition, type: bytes[27], extents: [] };
    if (allocationType === 3) {
      if (size > BigInt(allocations.length)) throw invalid('Embedded content exceeds the file entry.');
      file.embedded = allocations;
    } else {
      const width = allocationType === 0 ? 8 : allocationType === 1 ? 16 : 0;
      if (!width) throw unsupported('The file allocation descriptor type is not supported.');
      for (let i = 0; i < allocations.length; i += width) {
        bounds(BigInt(i), width, BigInt(allocations.length));
        const rawLength = allocations.readUInt32LE(i), extentLength = rawLength & 0x3fffffff;
        if (!extentLength) break;
        if (rawLength >>> 30) throw unsupported('The file extent is not recorded and allocated.');
        file.extents.push({ length: extentLength, block: allocations.readUInt32LE(i + 4),
          ...(width === 16 ? { partition: allocations.readUInt16LE(i + 8) } : {}) });
      }
    }
    return file;
  };
  // A metadata partition is itself a file on its underlying physical partition.
  for (const partition of partitions) if (partition.metadataLocation !== undefined) {
    partition.file = await readEntry(partition.source, BigInt(partition.metadataLocation) * block, sectorSize, true);
  }
  const readExtent = async extent => readPartition(partitionAt(extent.partition), BigInt(extent.block) * block, extent.length);
  const fileSetExtent = longExtent(volume, 248);
  if (fileSetExtent.length < 416) throw invalid('The file set descriptor extent is too short.');
  const fileSet = await readExtent({ ...fileSetExtent, length: 416 });
  requireTag(fileSet, 256);
  const rootExtent = longExtent(fileSet, 400);
  const root = await readEntry(partitionAt(rootExtent.partition), BigInt(rootExtent.block) * block, rootExtent.length);
  if (root.type !== 4) throw invalid('The root file entry is not a directory.');
  let cacheOffset = -1n, cache;
  const rootRead = async (offset, count) => {
    bounds(offset, count, root.size);
    if (!cache || offset < cacheOffset || offset + BigInt(count) > cacheOffset + BigInt(cache.length)) {
      cacheOffset = offset;
      cache = await readContent(root, offset, Number(root.size - offset > BigInt(chunkSize) ? BigInt(chunkSize) : root.size - offset));
    }
    return cache.subarray(Number(offset - cacheOffset), Number(offset - cacheOffset) + count);
  };
  let dvd = false, bluray = false;
  for (let offset = 0n; offset < root.size;) {
    abort(signal);
    const header = await rootRead(offset, 38);
    requireTag(header, 257);
    const flags = header[18], nameLength = header[19], implementationLength = header.readUInt16LE(36);
    const length = Math.ceil((38 + implementationLength + nameLength) / 4) * 4;
    bounds(offset, length, root.size);
    const name = nameFrom(await rootRead(offset + BigInt(38 + implementationLength), nameLength));
    if ((flags & 12) === 0 && (flags & 2) !== 0) {
      if (ordinalIgnoreCaseEquals(name, 'VIDEO_TS')) dvd = true;
      else if (ordinalIgnoreCaseEquals(name, 'BDMV')) bluray = true;
    }
    offset += BigInt(length);
  }
  return dvd ? 'Dvd' : bluray ? 'BluRay' : null;
}

/** Read only the root directory needed by the native ISO type classifier. */
export async function detectUdfDiscType(vfs, virtualPath, { signal, version } = {}) {
  try {
    const image = await imageReader(vfs, virtualPath, { signal, version });
    let result;
    try { result = await classify(image, signal); }
    catch (error) {
      abort(signal);
      if (error?.code === 'version-changed' || error?.code === 'cancelled' || error?.name === 'AbortError') throw error;
      // A changed image must not be mistaken for a stable, unrecognized format.
      await image.finish();
      throw error;
    }
    await image.finish();
    return result;
  }
  catch (error) {
    abort(signal);
    throw error;
  }
}
