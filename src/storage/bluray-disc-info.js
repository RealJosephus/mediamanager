// Playlist and clip information derived from BDInfo 0.8.0.
// See resources/bluray-disc-info-notice.txt for source and license.
import path from 'node:path';
import { StorageError, checkAbort } from './errors.js';
import { normalizePath } from './paths.js';
import { normalizeProbeFileDate } from './probe-lifecycle.js';

const metadataLimit = 16 * 1024 * 1024;
const evidence = new WeakMap();
const invalid = message => new StorageError('invalid-response', `Invalid Blu-ray structure: ${message}`);
const changed = () => new StorageError('version-changed', 'Blu-ray source files changed during reading.');
const modified = value => value == null ? null : normalizeProbeFileDate(value);
const videoTypes = new Set([1, 2, 0x1b, 0x24, 0xea]);
const audioTypes = new Set([3, 4, 0xf, 0x11, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);
const codecs = new Map([[1, 'mpeg1video'], [2, 'mpeg2video'], [0x1b, 'AVC'], [0x24, 'HEVC'], [0xea, 'vc1'],
  [3, 'MP1'], [4, 'MP2'], [0xf, 'MPEG-2 AAC'], [0x11, 'MPEG-4 AAC'], [0x80, 'LPCM'], [0x81, 'AC3'],
  [0x82, 'dts'], [0x83, 'TrueHD'], [0x84, 'eac3'], [0x85, 'dts'], [0x86, 'dts'], [0xa1, 'eac3'], [0xa2, 'dts'],
  [0x90, 'pgssub'], [0x91, 'IGS'], [0x92, 'SUB']]);

function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > bytes.length) throw invalid('A metadata record exceeds its containing file.');
  return bytes.subarray(offset, offset + length);
}
const u16 = (bytes, offset) => range(bytes, offset, 2).readUInt16BE();
const u32 = (bytes, offset) => range(bytes, offset, 4).readUInt32BE();
const signature = (bytes, type) => {
  if (![type + '0100', type + '0200', type + '0300'].includes(range(bytes, 0, 8).toString('ascii'))) {
    throw invalid(`The ${type} file version is not recognized.`);
  }
};

function clipStreams(bytes) {
  signature(bytes, 'HDMV');
  const start = u32(bytes, 12), block = range(bytes, start + 4, u32(bytes, start));
  range(block, 0, 10);
  const result = [], pids = new Set();
  let offset = 10;
  for (let index = 0; index < block[8]; index++) {
    const pid = u16(block, offset), size = range(block, offset + 2, 1)[0];
    const entry = range(block, offset + 3, size), streamType = range(entry, 0, 1)[0];
    offset += size + 3;
    let mediaStream;
    if (videoTypes.has(streamType)) {
      range(entry, 0, 3);
      const format = entry[1] >> 4, rate = entry[1] & 15;
      const height = [0, 480, 576, 480, 1080, 720, 1080, 576, 2160][format] ?? 0;
      const fraction = { 1: [24000, 1001], 2: [24000, 1000], 3: [25000, 1000], 4: [30000, 1001],
        6: [50000, 1000], 7: [60000, 1001] }[rate];
      mediaStream = { Type: 'Video', Codec: codecs.get(streamType), Height: height, IsInterlaced: format === 1 || format === 2 || format === 4,
        ...(fraction ? { AverageFrameRate: Math.fround(fraction[0] / fraction[1]), RealFrameRate: Math.fround(fraction[0] / fraction[1]) } : {}) };
    } else if (audioTypes.has(streamType)) {
      range(entry, 0, 5);
      mediaStream = { Type: 'Audio', Codec: codecs.get(streamType), Language: entry.toString('ascii', 2, 5),
        SampleRate: ({ 1: 48000, 4: 96000, 5: 192000, 12: 192000, 14: 96000 })[entry[1] & 15] ?? 0 };
    } else if ([0x90, 0x91, 0x92].includes(streamType)) {
      const language = streamType === 0x92 ? 2 : 1;
      mediaStream = { Type: 'Subtitle', Codec: codecs.get(streamType), Language: range(entry, language, 3).toString('ascii') };
    }
    // BDInfo ignores MVC in CLPI; its optional MVC stream comes from M2TS.
    if (mediaStream) {
      if (pids.has(pid)) throw invalid('A clip contains duplicate stream identifiers.');
      pids.add(pid); result.push({ pid, streamType, mediaStream });
    }
  }
  return result;
}

function playlist(bytes, filename, clips, media) {
  signature(bytes, 'MPLS');
  const offset = u32(bytes, 8), marks = u32(bytes, 12);
  const block = range(bytes, offset + 4, u32(bytes, offset));
  range(block, 0, 6);
  let position = 6, total = 0, angleCount = 0;
  const allClips = [], mainClips = [], seen = new Set();
  let hasLoops = false;
  const makeClip = (name, timeIn, timeOut, relativeTimeIn, angleIndex, relativeLength) => {
    if (name.length !== 5 || /[/\\\0]/u.test(name)) throw invalid('A playlist clip identifier is invalid.');
    const key = name.toUpperCase(), streams = clips.get(key + '.CLPI');
    if (!streams) throw invalid(`The playlist references missing clip information ${name}.`);
    const file = media.get(key + '.M2TS');
    if (angleIndex && !file) throw invalid(`The playlist references a missing angle ${name}.`);
    return { name: key + '.M2TS', virtualPath: file ?? null, timeIn, timeOut, relativeTimeIn,
      length: timeOut - timeIn, angleIndex, relativeLength, streams };
  };
  for (let index = 0; index < u16(block, 2); index++) {
    const size = u16(block, position), item = range(block, position + 2, size);
    range(item, 0, 32); position += size + 2;
    const name = item.toString('ascii', 0, 5);
    // In/out values are 45 kHz timestamps. Preserve the reference's high-bit mask.
    const timeIn = (u32(item, 12) & 0x7fffffff) / 45000;
    const timeOut = (u32(item, 16) & 0x7fffffff) / 45000;
    const clip = makeClip(name, timeIn, timeOut, total, 0, (timeOut - timeIn) / total);
    const loopKey = `${clip.name}:${timeIn}`;
    if (seen.has(loopKey)) hasLoops = true;
    seen.add(loopKey); allClips.push(clip); mainClips.push(clip); total += clip.length;
    if (item[10] & 16) {
      const count = range(item, 32, 2)[0];
      angleCount = Math.max(angleCount, count - 1);
      for (let angle = 1; angle < count; angle++) {
        const alternate = range(item, 34 + (angle - 1) * 10, 10).toString('ascii', 0, 5);
        allClips.push(makeClip(alternate, timeIn, timeOut, clip.relativeTimeIn, angle, 0));
      }
    }
  }
  const chapterBlock = range(bytes, marks + 4, u32(bytes, marks));
  const chapters = [];
  for (let index = 0; index < u16(chapterBlock, 0); index++) {
    const mark = range(chapterBlock, 2 + index * 14, 14);
    if (mark[1] !== 1) continue;
    const clip = mainClips[u16(mark, 2)];
    if (!clip) throw invalid('A chapter references an absent play item.');
    const seconds = u32(mark, 4) / 45000 - clip.timeIn + clip.relativeTimeIn;
    if (total - seconds > 1) chapters.push(seconds);
  }
  let reference = allClips[0];
  for (const clip of allClips) {
    if (!reference.virtualPath && clip.virtualPath) reference = clip;
    if (clip.streams.length > reference.streams.length && clip.relativeLength > 0.01) reference = clip;
    else if (clip.length > reference.length && clip.virtualPath) reference = clip;
  }
  const streams = [];
  // KeepStreamOrder is enabled: CLPI order within video/audio/graphics/text.
  for (const group of ['Video', 'Audio', 'Graphics', 'Text']) for (const stream of reference?.streams ?? []) {
    const kind = stream.mediaStream.Type === 'Subtitle' ? stream.streamType === 0x92 ? 'Text' : 'Graphics' : stream.mediaStream.Type;
    if (kind !== group) continue;
    for (let angleIndex = 0; angleIndex <= (group === 'Video' ? angleCount : 0); angleIndex++) {
      streams.push({ ...stream, angleIndex, mediaStream: { ...stream.mediaStream } });
    }
  }
  return { playlistName: path.posix.basename(filename).toUpperCase(), total, hasLoops, chapters, mainClips, reference, angleCount, streams };
}

function snapshot(virtualPath, stat) {
  if (stat.kind !== 'file' || stat.size == null) throw invalid('A metadata or media source is not a finite file.');
  return { virtualPath, size: stat.size, modified: stat.modified, version: stat.version };
}
function sameFile(before, after) {
  return after.kind === 'file' && after.size != null && BigInt(after.size) === BigInt(before.size)
    && modified(after.modified) === modified(before.modified) && (before.version == null || after.version === before.version);
}
async function list(vfs, directory, extension, signal) {
  const result = await vfs.list(directory, { signal });
  checkAbort(signal);
  if (result.complete !== true) throw new StorageError('incomplete-listing', 'Blu-ray directory enumeration is incomplete.');
  return result.entries.filter(entry => !entry.name.startsWith('.') && (extension
    ? entry.kind === 'file' && path.posix.extname(entry.name).toLowerCase() === extension : entry.kind === 'directory'));
}
async function referenceSsif(vfs, directory, filename, signal) {
  let entries;
  try { entries = await list(vfs, directory, '.ssif', signal); }
  catch (error) {
    checkAbort(signal);
    if (['not-found', 'not-directory'].includes(error.code)) return null;
    throw error;
  }
  const matches = entries.filter(entry => entry.name.toUpperCase() === filename);
  if (matches.length > 1) throw invalid('SSIF filenames collide when compared without case.');
  return matches.length ? path.posix.join(directory, matches[0].name) : null;
}
async function verify(vfs, state, signal) {
  checkAbort(signal);
  try {
    for (const before of state.sources.values()) {
      if (!sameFile(before, await vfs.stat(before.virtualPath, { signal }))) throw changed();
    }
    for (const before of state.directories) {
      const current = (await list(vfs, before.path, before.extension, signal)).map(entry => entry.name).sort();
      if (current.length !== before.names.length || current.some((name, index) => name !== before.names[index])) throw changed();
    }
    if (state.ssif && await referenceSsif(vfs, state.ssif.directory, state.ssif.filename, signal) !== state.ssif.path) throw changed();
  } catch (error) {
    checkAbort(signal);
    if (['not-found', 'not-directory', 'is-directory'].includes(error.code)) throw changed();
    throw error;
  }
  checkAbort(signal);
}
async function readMetadata(vfs, filename, state, signal) {
  const before = snapshot(filename, await vfs.stat(filename, { signal })); state.sources.set(filename, before);
  if (BigInt(before.size) > BigInt(metadataLimit)) throw new StorageError('not-supported', 'Blu-ray metadata exceeds the bounded read size.');
  const handle = await vfs.openRead(filename, { signal, ifMatch: before.version ?? undefined });
  let failure;
  try {
    checkAbort(signal);
    if (before.version != null && handle.version !== before.version) throw changed();
    if (handle.totalSize != null && BigInt(handle.totalSize) !== BigInt(before.size)) throw changed();
    if (handle.modified != null && modified(handle.modified) !== modified(before.modified)) throw changed();
    const bytes = Buffer.alloc(Number(before.size)); let written = 0;
    for await (const value of handle.stream) {
      checkAbort(signal);
      if (!(value instanceof Uint8Array) || written + value.length > bytes.length) throw invalid('A metadata read returned an invalid body.');
      bytes.set(value, written); written += value.length;
    }
    if (written !== bytes.length) throw invalid('A metadata read ended early.');
    checkAbort(signal); return bytes;
  } catch (error) { failure = error; checkAbort(signal); throw error; }
  finally { try { await handle.close(); } catch (error) { if (!failure) throw error; } }
}

/** Read the retained playlist plan. Times in clips/chapters are seconds; runtime
 * is TimeSpan ticks (100 ns). Stream fields are CLPI baselines: channels, bitrate
 * and codec-header extensions still require probing referenceFile. Bind SSIF
 * existence for the reference's optional MVC stream without reading its body.
 * No media bytes are read, and
 * a directory version is never a media cache key. */
export async function readBlurayDiscInfo(vfs, virtualPath, { signal } = {}) {
  virtualPath = normalizePath(virtualPath);
  const state = { sources: new Map(), directories: [] };
  try {
    checkAbort(signal);
    let bdmv;
    for (let current = virtualPath; current !== '/'; current = path.posix.dirname(current)) {
      if (path.posix.basename(current) === 'BDMV') { bdmv = current; break; }
    }
    if (!bdmv) {
      const children = await list(vfs, virtualPath, null, signal);
      if (!children.some(entry => entry.name === 'BDMV')) throw invalid('No BDMV directory was found.');
      bdmv = path.posix.join(virtualPath, 'BDMV');
    }
    const directories = await list(vfs, bdmv, null, signal);
    if (!['CLIPINF', 'PLAYLIST'].every(name => directories.some(entry => entry.name === name))) throw invalid('Clip information or playlists are absent.');
    const members = async (name, extension) => {
      const directory = path.posix.join(bdmv, name), entries = await list(vfs, directory, extension, signal);
      state.directories.push({ path: directory, extension, names: entries.map(entry => entry.name).sort() });
      const result = new Map();
      for (const entry of entries) {
        const key = entry.name.toUpperCase();
        if (result.has(key)) throw invalid('Disc filenames collide when compared without case.');
        result.set(key, path.posix.join(directory, entry.name));
      }
      return result;
    };
    const clips = new Map();
    for (const [name, filename] of await members('CLIPINF', '.clpi')) clips.set(name, clipStreams(await readMetadata(vfs, filename, state, signal)));
    const media = directories.some(entry => entry.name === 'STREAM') ? await members('STREAM', '.m2ts') : new Map();
    let selected;
    for (const filename of (await members('PLAYLIST', '.mpls')).values()) {
      const current = playlist(await readMetadata(vfs, filename, state, signal), filename, clips, media);
      if (!current.hasLoops && (!selected || current.total > selected.total)) selected = current;
    }
    if (!selected) { await verify(vfs, state, signal); return null; }
    if (!selected.mainClips.length || selected.mainClips.some(clip => !clip.virtualPath) || !selected.reference?.virtualPath) {
      throw invalid('The selected playlist has no complete set of media files.');
    }
    const describe = async clip => {
      if (!state.sources.has(clip.virtualPath)) state.sources.set(clip.virtualPath, snapshot(clip.virtualPath, await vfs.stat(clip.virtualPath, { signal })));
      return { ...state.sources.get(clip.virtualPath), timeIn: clip.timeIn, timeOut: clip.timeOut, relativeTimeIn: clip.relativeTimeIn };
    };
    const files = [];
    for (const clip of selected.mainClips) files.push(await describe(clip));
    const referenceFile = await describe(selected.reference);
    const ssifDirectory = path.posix.join(bdmv, 'STREAM', 'SSIF');
    const ssifFilename = path.posix.basename(referenceFile.virtualPath, path.posix.extname(referenceFile.virtualPath)).toUpperCase() + '.SSIF';
    const ssifPath = await referenceSsif(vfs, ssifDirectory, ssifFilename, signal);
    state.ssif = { directory: ssifDirectory, filename: ssifFilename, path: ssifPath };
    const result = { playlistName: selected.playlistName, runTimeTicks: BigInt(Math.trunc(selected.total * 10000000)),
      chapters: selected.chapters, files, referenceFile, referenceSsif: ssifPath, angleCount: selected.angleCount, streams: selected.streams };
    await verify(vfs, state, signal); evidence.set(result, state); return result;
  } catch (error) {
    checkAbort(signal); await verify(vfs, state, signal); throw error;
  }
}

/** Recheck the exact plan inputs after the caller has probed the media files. */
export async function verifyBlurayDiscInfo(vfs, info, { signal } = {}) {
  const state = evidence.get(info);
  if (!state) throw new TypeError('Expected a Blu-ray plan produced by readBlurayDiscInfo.');
  await verify(vfs, state, signal);
}
