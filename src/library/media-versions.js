import path from 'node:path';
import { idKey, sameId, nonemptyId, VIDEO_TYPES } from './records.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import invariantCharUpperMap from '../core/resources/invariant-char-upper.json' with { type: 'json' };
import { sortNative } from '../core/native-sort.js';

export function versionChildren(item, state, type) {
  const entries = state.links.filter(link => sameId(link.ParentId, item.Id) && Number(link.ChildType) === type)
    .sort((a, b) => a.SortOrder - b.SortOrder).map(link => state.byId.get(idKey(link.ChildId))).filter(Boolean);
  return type === 3 ? entries.filter(entry => VIDEO_TYPES.has(entry.Type)).sort((a, b) => String(a.SortName ?? '').localeCompare(String(b.SortName ?? ''))) : entries;
}

export function mediaVersions(item, state) {
  if (!VIDEO_TYPES.has(item.Type)) return [{ item, type: 'Default' }];
  let primary = nonemptyId(item.PrimaryVersionId) ? state.byId.get(idKey(item.PrimaryVersionId)) : null;
  if (!VIDEO_TYPES.has(primary?.Type)) primary = null;
  const primaryLinked = primary ? versionChildren(primary, state, 3) : [];
  const grouped = [{ item, type: 'Default' }, ...versionChildren(item, state, 3).map(item => ({ item, type: 'Grouping' }))];
  if (primary) grouped.push({ item: primary, type: primaryLinked.some(entry => sameId(entry.Id, item.Id)) ? 'Grouping' : 'Default' },
    ...primaryLinked.map(item => ({ item, type: 'Grouping' })));
  const all = [...grouped, ...grouped.filter(entry => VIDEO_TYPES.has(entry.item.Type)).flatMap(entry => versionChildren(entry.item, state, 2).map(item => ({ item, type: 'Default' })))];
  const unique = new Map();
  for (const entry of all) if (!unique.has(idKey(entry.item.Id))) unique.set(idKey(entry.item.Id), entry);
  return [...unique.values()];
}

export function mediaSourceCount(item, state, seen = new Set()) {
  const primary = nonemptyId(item.PrimaryVersionId) && state.byId.get(idKey(item.PrimaryVersionId));
  if (primary && VIDEO_TYPES.has(primary.Type)) {
    if (!seen.has(idKey(primary.Id))) { seen.add(idKey(primary.Id)); return mediaSourceCount(primary, state, seen); }
    item = primary;
  }
  // The native count includes unresolved local links, but only resolved video group links.
  return 1 + versionChildren(item, state, 3).length + state.links.filter(link => sameId(link.ParentId, item.Id) && Number(link.ChildType) === 2).length;
}

const invariantCharUpper = character => invariantCharUpperMap[character] ?? character;

export function commonVersionPrefix(names) {
  if (!names.length) return '';
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let count = 0;
    while (count < Math.min(prefix.length, name.length) && invariantCharUpper(prefix[count]) === invariantCharUpper(name[count])) count++;
    prefix = prefix.slice(0, count);
  }
  if (names.some(name => name.length === prefix.length)) return prefix;
  const decimal = index => index > 0 && prefix[index] === '.' && /\p{Nd}/u.test(prefix[index - 1])
    && (index + 1 < prefix.length ? /\p{Nd}/u.test(prefix[index + 1]) : names.every(name => name.length > index + 1 && /\p{Nd}/u.test(name[index + 1])));
  let cut = prefix.length;
  while (cut > 0 && (!'-_.'.includes(prefix[cut - 1]) || decimal(cut - 1))) cut--;
  if (!cut) { cut = prefix.length; while (cut > 0 && prefix[cut - 1] !== ' ') cut--; }
  return prefix.slice(0, cut);
}

export const isFileSource = item => !item.Path || !/^(?:rtsp|rtmp|http|rtp|ftp|udp)/i.test(item.Path) && !/^[a-z][a-z\d+.-]*:\/\//i.test(item.Path);
export const sourceFileName = item => path.win32.basename(item.Path, path.win32.extname(item.Path));

export function mediaSourceName(item, queriedItem, state, prefix) {
  const terms = [];
  if (isFileSource(item) && item.Path) {
    const displayName = sourceFileName(item);
    const addSuffix = common => {
      if (common && displayName.length > common.length && ordinalIgnoreCaseEquals(displayName.slice(0, common.length), common)) {
        const suffix = displayName.slice(common.length).replace(/^[ _.-]+/, '');
        if (suffix.trim()) terms.push(suffix);
      }
    };
    addSuffix(prefix);
    if (!terms.length && versionChildren(queriedItem, state, 2).length) {
      const directory = ['Dvd', 'BluRay'].includes(queriedItem.VideoType) && !queriedItem.IsPlaceHolder && !queriedItem.AdditionalParts?.length
        ? queriedItem.Path : path.win32.dirname(queriedItem.Path);
      addSuffix(path.win32.basename(directory));
    }
    if (!terms.length) terms.push(displayName);
  }
  if (!terms.length) terms.push(item.Name);
  if (VIDEO_TYPES.has(item.Type)) {
    if (item.Video3DFormat != null) terms.push('3D');
    if (item.VideoType === 'BluRay' || item.VideoType === 'Iso' && item.IsoType === 'BluRay') terms.push('Bluray');
    else if (item.VideoType === 'Dvd' || item.VideoType === 'Iso' && item.IsoType === 'Dvd') terms.push('DVD');
    else if (item.VideoType === 'Iso' && item.IsoType == null) terms.push('ISO');
  }
  return terms.join('/');
}

const videoStream = source => source.MediaStreams.find(stream => stream.Type === 'Video');
const width = source => videoStream(source)?.Width ?? 0;

// MediaSourceWidthComparator compares only identical paths, distinguishes an
// absent video stream, and retains the CLR's unchecked Int32 subtraction.
export function compareMediaSourceWidth(a, b) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  const samePath = a.Path == null ? b.Path == null : b.Path != null && ordinalIgnoreCaseEquals(a.Path, b.Path);
  if (!samePath) return 0;
  const first = videoStream(a), second = videoStream(b);
  if (first == null) return second == null ? 0 : -1;
  if (second == null) return 1;
  return ((first.Width ?? 0) - (second.Width ?? 0)) | 0;
}

export function sortMediaSources(sources, preferredId, playback = false) {
  return sortNative(sources, (a, b) => Number(sameId(b.Id, preferredId)) - Number(sameId(a.Id, preferredId))
    || Number(a.VideoType !== 'VideoFile') - Number(b.VideoType !== 'VideoFile')
    || Number(a.Video3DFormat != null) - Number(b.Video3DFormat != null)
    || (playback ? width(b) - width(a) : -Math.sign(compareMediaSourceWidth(a, b))));
}
