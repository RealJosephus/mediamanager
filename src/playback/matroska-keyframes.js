import { checkAbort, StorageError } from '../storage/errors.js';

const ids = Object.freeze({
  segment: 0x18538067n,
  seekHead: 0x114d9b74n,
  seek: 0x4dbbn,
  seekId: 0x53abn,
  seekPosition: 0x53acn,
  info: 0x1549a966n,
  timestampScale: 0x2ad7b1n,
  duration: 0x4489n,
  tracks: 0x1654ae6bn,
  trackEntry: 0xaen,
  trackNumber: 0xd7n,
  trackType: 0x83n,
  cues: 0x1c53bb6bn,
  cuePoint: 0xbbn,
  cueTime: 0xb3n,
  cueTrackPositions: 0xb7n,
  cueTrack: 0xf7n,
  cueClusterPosition: 0xf1n,
});

const pageBytes = 64n * 1024n;
const maximumReadBytes = 64n * 1024n * 1024n;
const maximumSeekHeadDistance = 4n * 1024n * 1024n;
const maximumContainerBytes = 64n * 1024n * 1024n;
const maximumElements = 1000000;
const maximumInt64 = 2n ** 63n - 1n;

const invalid = message => new StorageError('invalid-response', `Invalid Matroska metadata: ${message}`);
const unsupported = message => new StorageError('not-supported', `Matroska keyframe extraction is unavailable: ${message}`);

function exactNonnegative(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw invalid(`${label} is not an exact nonnegative integer.`);
}

function versionCapabilities(vfs, virtualPath) {
  const capabilities = vfs.capabilities(virtualPath);
  if (capabilities.randomRead !== true || capabilities.reliableLength !== true || capabilities.reliableVersion !== true) {
    throw unsupported('the VFS cannot prove random ranges, length, and source version.');
  }
}

function sameVersion(actual, expected, size) {
  if (actual?.kind !== 'file' || actual.version == null || actual.version !== expected) return false;
  try { return exactNonnegative(actual.size, 'source size') === size; }
  catch { return false; }
}

class RangeReader {
  #pages = new Map();
  #readBytes = 0n;

  constructor(vfs, virtualPath, size, version, signal) {
    Object.assign(this, { vfs, virtualPath, size, version, signal });
  }

  async #page(start) {
    checkAbort(this.signal);
    const key = start.toString();
    if (this.#pages.has(key)) return this.#pages.get(key);
    const end = start + pageBytes - 1n < this.size ? start + pageBytes - 1n : this.size - 1n;
    const length = end - start + 1n;
    if (this.#readBytes + length > maximumReadBytes) throw unsupported('the bounded metadata read budget was exceeded.');
    let handle;
    try {
      handle = await this.vfs.openRead(this.virtualPath, { range: { start, end }, ifMatch: this.version, signal: this.signal });
      checkAbort(this.signal);
      if (!handle.rangeHonored || handle.version !== this.version || handle.totalSize !== this.size
        || handle.range?.start !== start || handle.range?.end !== end || handle.contentLength !== length) {
        throw unsupported('the VFS did not prove the requested source range and version.');
      }
      const chunks = [];
      let received = 0n;
      for await (const chunk of handle.stream) {
        checkAbort(this.signal);
        const bytes = Buffer.from(chunk);
        received += BigInt(bytes.length);
        if (received > length) throw invalid('a source range exceeded its declared length.');
        chunks.push(bytes);
      }
      if (received !== length) throw invalid('a source range ended before its declared length.');
      const bytes = Buffer.concat(chunks);
      this.#readBytes += length;
      // Keep only a few pages. Sparse SeekHead targets must not retain an
      // attacker-controlled amount of source data in memory.
      if (this.#pages.size >= 8) this.#pages.delete(this.#pages.keys().next().value);
      this.#pages.set(key, bytes);
      return bytes;
    } catch (error) {
      checkAbort(this.signal);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async read(offset, length) {
    offset = exactNonnegative(offset, 'range offset');
    length = exactNonnegative(length, 'range length');
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('one metadata value exceeds the in-memory limit.');
    if (offset > this.size || length > this.size - offset) throw invalid('an element range is outside the source.');
    if (length === 0n) return Buffer.alloc(0);
    const chunks = [];
    let position = offset;
    while (position < offset + length) {
      const pageStart = position / pageBytes * pageBytes;
      const page = await this.#page(pageStart);
      const pageOffset = Number(position - pageStart);
      const count = Number((offset + length - position) < BigInt(page.length - pageOffset)
        ? offset + length - position : BigInt(page.length - pageOffset));
      chunks.push(page.subarray(pageOffset, pageOffset + count));
      position += BigInt(count);
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }
}

function vintLength(first, maximum) {
  if (first === 0) throw invalid('an EBML variable integer has no marker bit.');
  let marker = 0x80;
  for (let length = 1; length <= maximum; length++, marker >>= 1) if ((first & marker) !== 0) return length;
  throw invalid('an EBML variable integer is too wide.');
}

async function elementHeader(reader, offset, boundary) {
  offset = exactNonnegative(offset, 'element offset');
  boundary = exactNonnegative(boundary, 'container boundary');
  if (offset >= boundary) throw invalid('an element header starts outside its container.');
  const firstId = (await reader.read(offset, 1n))[0];
  const idLength = vintLength(firstId, 4);
  const idBytes = await reader.read(offset, BigInt(idLength));
  let id = 0n;
  for (const byte of idBytes) id = id << 8n | BigInt(byte);
  const sizeOffset = offset + BigInt(idLength);
  if (sizeOffset >= boundary) throw invalid('an element is missing its size.');
  const firstSize = (await reader.read(sizeOffset, 1n))[0];
  const sizeLength = vintLength(firstSize, 8);
  const sizeBytes = await reader.read(sizeOffset, BigInt(sizeLength));
  const marker = 1 << (8 - sizeLength);
  let size = BigInt(firstSize & (marker - 1));
  for (let index = 1; index < sizeBytes.length; index++) size = size << 8n | BigInt(sizeBytes[index]);
  const unknown = size === (1n << BigInt(7 * sizeLength)) - 1n;
  const dataStart = sizeOffset + BigInt(sizeLength);
  if (dataStart > boundary) throw invalid('an element header crosses its container boundary.');
  const end = unknown ? null : dataStart + size;
  if (end != null && end > boundary) throw invalid('an element payload crosses its container boundary.');
  return { id, start: offset, dataStart, size: unknown ? null : size, end };
}

async function eachChild(reader, container, callback, { maximumBytes = maximumContainerBytes } = {}) {
  if (container.end == null) throw invalid('an unknown-size metadata container cannot be traversed safely.');
  if (container.end - container.dataStart > maximumBytes) throw unsupported('a metadata container exceeds the bounded parser limit.');
  let offset = container.dataStart;
  for (let count = 0; offset < container.end; count++) {
    if (count >= maximumElements) throw unsupported('a metadata container has too many elements.');
    const child = await elementHeader(reader, offset, container.end);
    if (child.end == null) throw invalid('an unknown-size child metadata element is unsupported.');
    if (await callback(child, count) === false) return false;
    if (child.end <= offset) throw invalid('an element did not advance the parser.');
    offset = child.end;
  }
  if (offset !== container.end) throw invalid('a metadata container ended between elements.');
  return true;
}

async function findChild(reader, container, identifier, start = container.dataStart, maximumBytes = maximumContainerBytes) {
  if (container.end == null) throw invalid('an unknown-size metadata container cannot be traversed safely.');
  if (container.end - container.dataStart > maximumBytes) throw unsupported('a metadata container exceeds the bounded parser limit.');
  let offset = start;
  for (let count = 0; offset < container.end; count++) {
    if (count >= maximumElements) throw unsupported('a metadata container has too many elements.');
    const child = await elementHeader(reader, offset, container.end);
    if (child.end == null) throw invalid('an unknown-size child metadata element is unsupported.');
    if (child.id === identifier) return child;
    offset = child.end;
  }
  return undefined;
}

async function unsignedValue(reader, element, label) {
  if (element.size == null || element.size < 1n || element.size > 8n) throw invalid(`${label} must contain one to eight bytes.`);
  const bytes = await reader.read(element.dataStart, element.size);
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  return value;
}

async function binaryIdentifier(reader, element) {
  if (element.size == null || element.size < 1n || element.size > 4n) throw invalid('SeekID must contain a valid EBML identifier.');
  const bytes = await reader.read(element.dataStart, element.size);
  if (vintLength(bytes[0], 4) !== bytes.length) throw invalid('SeekID has a non-canonical identifier width.');
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  return value;
}

async function floatValue(reader, element) {
  if (element.size !== 4n && element.size !== 8n) throw invalid('Duration must contain a four- or eight-byte float.');
  const bytes = await reader.read(element.dataStart, element.size);
  const value = element.size === 4n ? bytes.readFloatBE() : bytes.readDoubleBE();
  if (!Number.isFinite(value) || value < 0) throw invalid('Duration is not finite and nonnegative.');
  return value;
}

function roundedScaledDuration(value, scale) {
  // Preserve the CLR operation order: UInt64 scale converts to binary64, the
  // multiplication and division each round in binary64, then Convert.ToInt64
  // applies midpoint-to-even rounding.
  const scaled = value * Number(scale) / 100;
  if (!Number.isFinite(scaled) || scaled < 0 || scaled >= 2 ** 63) throw invalid('Duration exceeds the Int64 tick range.');
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const rounded = fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  return BigInt(rounded);
}

function scaledCueTime(value, scale) {
  if (value > maximumInt64) throw invalid('a cue time exceeds the supported Int64 input range.');
  // The pinned native extractor performs unchecked Int64 multiplication. Do
  // not reproduce its wraparound for hostile metadata: reject before the
  // multiply so a large CueTime cannot silently become a different timestamp.
  if (value !== 0n && scale > maximumInt64 / value) throw invalid('a cue time overflows the Int64 scaling intermediate.');
  const result = value * scale / 100n;
  if (result > maximumInt64) throw invalid('a cue time exceeds the Int64 tick range.');
  return result;
}

async function findSegment(reader) {
  let offset = 0n;
  for (let count = 0; offset < reader.size && count < 32; count++) {
    if (offset > maximumSeekHeadDistance) throw unsupported('the Segment header is outside the bounded prefix scan.');
    const element = await elementHeader(reader, offset, reader.size);
    if (element.id === ids.segment) return { ...element, end: element.end ?? reader.size };
    if (element.end == null) throw invalid('an unknown-size top-level element precedes Segment.');
    offset = element.end;
  }
  throw invalid('the file has no Segment container in its bounded prefix.');
}

async function findSeekHead(reader, segment) {
  let offset = segment.dataStart;
  for (let count = 0; offset < segment.end && count < 4096; count++) {
    if (offset - segment.dataStart > maximumSeekHeadDistance) throw unsupported('SeekHead is outside the bounded Segment scan.');
    const element = await elementHeader(reader, offset, segment.end);
    if (element.id === ids.seekHead) return element;
    if (element.end == null) throw invalid('an unknown-size Segment child precedes SeekHead.');
    offset = element.end;
  }
  throw invalid('the Segment has no supported SeekHead.');
}

async function readSeekHead(reader, segment, seekHead) {
  const positions = new Map();
  await eachChild(reader, seekHead, async child => {
    if (child.id !== ids.seek) return;
    if (child.end == null || child.end - child.dataStart > 1024n * 1024n) throw unsupported('a Seek entry exceeds the bounded parser limit.');
    const seekId = await elementHeader(reader, child.dataStart, child.end);
    if (seekId.id !== ids.seekId || seekId.size !== 4n || seekId.end == null) throw invalid('a Seek entry does not start with a four-byte SeekID.');
    const target = await binaryIdentifier(reader, seekId);
    if ([ids.info, ids.tracks, ids.cues].includes(target)) {
      if (seekId.end >= child.end) throw invalid('a required Seek entry has no SeekPosition.');
      const seekPosition = await elementHeader(reader, seekId.end, child.end);
      if (seekPosition.id !== ids.seekPosition) throw invalid('SeekPosition does not follow SeekID.');
      const position = await unsignedValue(reader, seekPosition, 'SeekPosition');
      if (position > maximumInt64) throw invalid('SeekPosition exceeds Int64.');
      positions.set(target, position);
    }
    if ([ids.info, ids.tracks, ids.cues].every(targetId => positions.has(targetId))) return false;
  }, { maximumBytes: 1024n * 1024n });
  for (const target of [ids.info, ids.tracks, ids.cues]) if (!positions.has(target)) {
    throw invalid('SeekHead does not contain Info, Tracks, and Cues positions.');
  }
  const result = new Map();
  for (const [target, relative] of positions) {
    const absolute = segment.dataStart + relative;
    if (absolute < segment.dataStart || absolute >= segment.end) throw invalid('a SeekPosition is outside Segment.');
    const element = await elementHeader(reader, absolute, segment.end);
    if (element.id !== target) throw invalid('a SeekPosition does not address its declared element.');
    if (element.end == null) throw invalid('a sought metadata element has unknown size.');
    result.set(target, element);
  }
  return result;
}

async function readInfo(reader, info) {
  const timestampElement = await findChild(reader, info, ids.timestampScale, info.dataStart, 1024n * 1024n);
  if (!timestampElement) throw invalid('Info has no TimestampScale.');
  const timestampScale = await unsignedValue(reader, timestampElement, 'TimestampScale');
  if (timestampScale < 1n || timestampScale > maximumInt64) throw invalid('Info has no valid TimestampScale.');
  const durationElement = await findChild(reader, info, ids.duration, timestampElement.end, 1024n * 1024n);
  const duration = durationElement ? await floatValue(reader, durationElement) : 0;
  return { timestampScale, duration };
}

async function readVideoTrack(reader, tracks) {
  let videoTrack;
  await eachChild(reader, tracks, async child => {
    if (child.id !== ids.trackEntry) return;
    const numberElement = await findChild(reader, child, ids.trackNumber, child.dataStart, 4n * 1024n * 1024n);
    if (!numberElement) throw invalid('a TrackEntry has no TrackNumber.');
    const trackNumber = await unsignedValue(reader, numberElement, 'TrackNumber');
    const typeElement = await findChild(reader, child, ids.trackType, numberElement.end, 4n * 1024n * 1024n);
    if (!typeElement || trackNumber < 1n || trackNumber > maximumInt64) throw invalid('a TrackEntry has no valid TrackNumber followed by TrackType.');
    const trackType = await unsignedValue(reader, typeElement, 'TrackType');
    if (trackType === 1n) { videoTrack = trackNumber; return false; }
  }, { maximumBytes: 16n * 1024n * 1024n });
  if (videoTrack == null) throw invalid('Tracks has no video track.');
  return videoTrack;
}

async function readCuePosition(reader, cueTrackPositions, segment) {
  const trackElement = await findChild(reader, cueTrackPositions, ids.cueTrack, cueTrackPositions.dataStart, 1024n * 1024n);
  if (!trackElement) return { track: undefined, absoluteCluster: undefined };
  const track = await unsignedValue(reader, trackElement, 'CueTrack');
  let absoluteCluster;
  const clusterElement = await findChild(reader, cueTrackPositions, ids.cueClusterPosition, trackElement.end, 1024n * 1024n);
  if (clusterElement?.size != null && clusterElement.size >= 1n && clusterElement.size <= 8n) {
    // Native keyframe selection does not require CueClusterPosition. Parse a
    // valid value using its Segment-payload base, but do not reject a cue
    // solely because this unused optional position is absent or out of range.
    const relativeCluster = await unsignedValue(reader, clusterElement, 'CueClusterPosition');
    if (relativeCluster <= maximumInt64) {
      const absolute = segment.dataStart + relativeCluster;
      if (absolute >= segment.dataStart && absolute < segment.end) absoluteCluster = absolute;
    }
  }
  if (track == null || track < 1n || track > maximumInt64) throw invalid('CueTrackPositions has no valid CueTrack.');
  return { track, absoluteCluster };
}

async function readCues(reader, cues, segment, videoTrack, timestampScale) {
  const keyframes = [];
  await eachChild(reader, cues, async child => {
    if (child.id !== ids.cuePoint) return;
    const timeElement = await findChild(reader, child, ids.cueTime, child.dataStart, 1024n * 1024n);
    if (!timeElement) throw invalid('a CuePoint has no CueTime.');
    const cueTime = await unsignedValue(reader, timeElement, 'CueTime');
    const positionElement = await findChild(reader, child, ids.cueTrackPositions, timeElement.end, 1024n * 1024n);
    if (!positionElement) throw invalid('a CuePoint has no CueTrackPositions after CueTime.');
    const firstPosition = await readCuePosition(reader, positionElement, segment);
    if (firstPosition.track === videoTrack) keyframes.push(scaledCueTime(cueTime, timestampScale));
  });
  return keyframes;
}

/**
 * Reads only version-bound VFS ranges and returns native 100 ns keyframe ticks.
 * Unsupported or malformed files throw; the HLS integration decides whether a
 * failure is eligible for the native equal-segment fallback.
 */
export async function extractMatroskaKeyframes(vfs, virtualPath, { signal } = {}) {
  try {
    checkAbort(signal);
    versionCapabilities(vfs, virtualPath);
    const before = await vfs.stat(virtualPath, { signal });
    if (before.kind !== 'file') throw new StorageError('is-directory', 'The Matroska source is not a file.');
    const size = exactNonnegative(before.size, 'source size');
    if (size < 1n || before.version == null) throw unsupported('the VFS did not supply a reliable source length and version.');
    const reader = new RangeReader(vfs, virtualPath, size, before.version, signal);
    const segment = await findSegment(reader);
    const seekHead = await findSeekHead(reader, segment);
    const sought = await readSeekHead(reader, segment, seekHead);
    const info = await readInfo(reader, sought.get(ids.info));
    const videoTrack = await readVideoTrack(reader, sought.get(ids.tracks));
    const keyframeTicks = await readCues(reader, sought.get(ids.cues), segment, videoTrack, info.timestampScale);
    const after = await vfs.stat(virtualPath, { signal });
    if (!sameVersion(after, before.version, size)) throw new StorageError('version-changed', 'The Matroska source changed during keyframe extraction.');
    checkAbort(signal);
    return { TotalDuration: roundedScaledDuration(info.duration, info.timestampScale), KeyframeTicks: keyframeTicks,
      source: { size, version: before.version } };
  } catch (error) {
    // Storage adapters may surface their native AbortError instead of a
    // StorageError. Keep cancellation stable at the extraction boundary so
    // the owner rejects while independent waiters can retry the shared work.
    checkAbort(signal);
    throw error;
  }
}

function rowIdentity(row) {
  return row && JSON.stringify([row.Id, row.Path, row.DateModified, row.Size?.toString(), row.Data, row.RunTimeTicks?.toString()]);
}

function waitForActive(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new StorageError('cancelled', 'Matroska keyframe extraction was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

export class MatroskaKeyframeService {
  #active = new Map();

  constructor({ store, vfs, onError = () => {} }) {
    if (!store || !vfs) throw new TypeError('Matroska keyframe extraction requires a domain store and VFS.');
    Object.assign(this, { store, vfs, onError });
  }

  async get(itemId, virtualPath, { signal } = {}) {
    checkAbort(signal);
    if (this.#active.has(itemId)) {
      const active = this.#active.get(itemId);
      try {
        const result = await waitForActive(active.promise, signal);
        if (active.virtualPath === virtualPath) return result;
        if (this.#active.get(itemId) === active) this.#active.delete(itemId);
        return this.get(itemId, virtualPath, { signal });
      }
      catch (error) {
        // The owner uses its request signal so a lone aborted request stops
        // remote reads. An independent waiter retries instead of inheriting
        // that caller's cancellation.
        if (error.code !== 'cancelled' || signal?.aborted) throw error;
        if (this.#active.get(itemId) === active) this.#active.delete(itemId);
        return this.get(itemId, virtualPath, { signal });
      }
    }
    const promise = this.#extractAndSave(itemId, virtualPath, signal);
    const active = { virtualPath, promise };
    this.#active.set(itemId, active);
    try { return await promise; }
    finally { if (this.#active.get(itemId) === active) this.#active.delete(itemId); }
  }

  async #extractAndSave(itemId, virtualPath, signal) {
    const initial = await this.store.run(async database => (await database.rows('BaseItems', { where: { Id: itemId }, limit: 1 }))[0]);
    if (!initial) throw new StorageError('not-found', 'The media item does not exist.');
    let data;
    try { data = await extractMatroskaKeyframes(this.vfs, virtualPath, { signal }); }
    catch (error) {
      if (error.code === 'cancelled') throw error;
      this.onError(error);
      return undefined;
    }
    if (!data.KeyframeTicks.length) return undefined;
    checkAbort(signal);
    try {
      await this.store.transaction(async database => {
        const current = (await database.rows('BaseItems', { where: { Id: itemId }, limit: 1 }))[0];
        if (rowIdentity(current) !== rowIdentity(initial)) throw new StorageError('version-changed', 'The media item changed during keyframe extraction.');
        const source = await this.vfs.stat(virtualPath, { signal });
        if (!sameVersion(source, data.source.version, data.source.size)) throw new StorageError('version-changed', 'The Matroska source changed before keyframe persistence.');
        await database.delete('KeyframeData', { ItemId: itemId });
        await database.insert('KeyframeData', { ItemId: itemId, TotalDuration: data.TotalDuration,
          KeyframeTicks: `[${data.KeyframeTicks.map(String).join(',')}]` });
        checkAbort(signal);
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === 'version-changed') { this.onError(error); return undefined; }
      throw error;
    }
    return { TotalDuration: data.TotalDuration, KeyframeTicks: data.KeyframeTicks };
  }
}
