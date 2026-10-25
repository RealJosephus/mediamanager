import { dateText, dateTicks } from '../library/records.js';
import { ordinalIgnoreCaseKey } from './ordinal-comparer.js';

const videoTypes = new Set(['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer']);
export const probeItemType = item => String(item.Type ?? '').split('.').at(-1);
export const probeIsVideo = item => videoTypes.has(probeItemType(item));
export const supportsProbeMetadata = item => probeIsVideo(item) || ['Audio', 'AudioBook'].includes(probeItemType(item));
export const probeFileProtocol = item => item.IsFileProtocol ?? Boolean(item.Path && !/^(?:http|rtsp|rtmp|rtp|ftp|udp)/iu.test(item.Path) && !item.Path.includes('://'));
export const probeCompleteMedia = item => item.IsCompleteMedia ?? (item.SourceType !== 'Channel' || !(item.Tags ?? []).some(tag => ordinalIgnoreCaseKey(tag) === 'LIVESTREAM'));

export function normalizeProbeFileDate(value) {
  const text = value instanceof Date ? value.toISOString() : value;
  // AList exposes RFC3339 timestamps with offsets and up to nanosecond precision.
  // Native file times compare at 100 ns precision; retain that precision when
  // normalizing the transport timestamp instead of rounding through Date.
  const match = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/u.exec(text);
  return match ? new Date(match[1].replace(' ', 'T') + match[3]).toISOString().slice(0, 19) + '.' + (match[2] ?? '').padEnd(7, '0').slice(0, 7) + 'Z' : dateText(text);
}

export function probeFileChanged(item, modified) {
  if (modified == null) return false;
  const difference = dateTicks(item.DateModified) - dateTicks(normalizeProbeFileDate(modified));
  return (difference < 0n ? -difference : difference) > 10000000n;
}

export function missingProbeInfo(item) {
  if (item.RunTimeTicks != null || item.TotalBitrate != null || item.IsVirtualItem || item.IsShortcut || !probeFileProtocol(item)) return false;
  return probeIsVideo(item) ? !item.IsPlaceHolder && probeCompleteMedia(item) : ['Audio', 'AudioBook'].includes(probeItemType(item));
}

export function probeExternalFilesChanged(previous = [], candidates = []) {
  // Native comparison uses an ordinal saved set against the first spelling of
  // each path in an ordinal-ignore-case discovered set.
  const discovered = new Map();
  for (const filename of candidates) if (!discovered.has(ordinalIgnoreCaseKey(filename))) discovered.set(ordinalIgnoreCaseKey(filename), filename);
  const stored = new Set(previous);
  return stored.size !== discovered.size || [...discovered.values()].some(filename => !stored.has(filename));
}

export function probeFetchDecision(item, options = {}) {
  if (!supportsProbeMetadata(item)) return 'unsupported-type';
  if (options.MetadataRefreshMode === 'None') return 'metadata-disabled';
  if (probeIsVideo(item) && item.IsPlaceHolder) return 'placeholder';
  if (probeIsVideo(item) && !probeCompleteMedia(item)) return 'incomplete-media';
  if (item.IsVirtualItem) return 'virtual-item';
  if (!options.EnableRemoteContentProbe && !probeFileProtocol(item)) return 'remote-probe-disabled';
  return null;
}
