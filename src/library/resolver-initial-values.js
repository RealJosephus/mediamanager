import { nativeDate } from '../sessions/user-data.js';
import { normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { dateText, MIN_DATE } from './records.js';
import { nativeContainingFolderPath, nativeFileName, nativeFileNameWithoutExtension } from './native-path.js';

function attributeIndex(value, attribute) {
  for (let index = 0; index <= value.length - attribute.length; index++) {
    if (ordinalIgnoreCaseEquals(value.slice(index, index + attribute.length), attribute)) return index;
  }
  return -1;
}

/** Frozen PathExtensions.GetAttributeValue, including its short aliases and
 * case-sensitive IMDb fallback. The first valid bracketed occurrence wins. */
export function providerAttributeValue(value, attribute) {
  if (!value || !attribute) throw new TypeError('Provider attributes require a nonempty name and path.');
  const alias = ['tmdbid', 'tvdbid', 'imdbid'].find(name => ordinalIgnoreCaseEquals(attribute, name))?.slice(0, -2);
  const search = alias ?? attribute;
  let offset = 0;
  while (offset <= value.length - search.length) {
    const remaining = value.slice(offset), index = attributeIndex(remaining, search);
    if (index < 0) break;
    let end = index + search.length;
    offset += end;
    if (index === 0) continue;
    const closer = { '[': ']', '(': ')', '{': '}' }[remaining[index - 1]];
    if (!closer) continue;
    if (alias && ordinalIgnoreCaseEquals(remaining.slice(end, end + 2), 'id')) end += 2;
    if (end + 2 >= remaining.length || !['=', '-'].includes(remaining[end])) continue;
    const closing = remaining.indexOf(closer, end);
    if (closing <= end + 1) continue;
    const result = clrTrim(remaining.slice(end + 1, closing));
    if (result) return result;
  }
  if (!ordinalIgnoreCaseEquals(attribute, 'imdbid')) return null;
  let text = value;
  while (text.length >= 9) {
    const index = text.indexOf('tt');
    if (index < 0) return null;
    text = text.slice(index);
    let end = 2;
    while (end < Math.min(text.length, 10) && text[end] >= '0' && text[end] <= '9') end++;
    if (end >= 9) return text.slice(0, end);
    text = text.slice(end);
  }
  return null;
}

export function setResolverProviderIdsFromPath(item) {
  const type = item.Type ?? item.NativeType?.split('.').at(-1);
  if (['Series', 'Season', 'Episode'].includes(type)) {
    const name = type === 'Episode' ? nativeFileNameWithoutExtension(item.Path) : nativeFileName(item.Path);
    if (!name) return item;
    const attributes = [['Tvdb', 'tvdbid'], ['TvMaze', 'tvmazeid'], ['Tmdb', 'tmdbid']];
    if (type !== 'Season') attributes.unshift(['Imdb', 'imdbid']);
    if (type !== 'Episode') attributes.push(['AniDB', 'anidbid'], ['AniList', 'anilistid'], ['AniSearch', 'anisearchid']);
    item.ProviderIds ??= {};
    for (const [provider, attribute] of attributes) {
      const value = providerAttributeValue(name, attribute);
      if (value) item.ProviderIds[provider] = value;
    }
    return item;
  }
  if (type === 'BoxSet') {
    const name = nativeFileName(item.Path), value = name && providerAttributeValue(name, 'tmdbid');
    if (value) { item.ProviderIds ??= {}; item.ProviderIds.Tmdb = value; }
    return item;
  }
  if (!['Movie', 'MusicVideo'].includes(type)) return item;
  const fileName = nativeFileName(item.Path);
  const name = item.IsInMixedFolder ? fileName : nativeFileName(nativeContainingFolderPath(item));
  item.ProviderIds ??= {};
  for (const [provider, attribute] of [['Tmdb', 'tmdbid'], ['Tvdb', 'tvdbid']]) {
    const value = providerAttributeValue(name, attribute)
      ?? (item.IsInMixedFolder ? null : providerAttributeValue(fileName, attribute));
    if (value) item.ProviderIds[provider] = value;
  }
  const imdb = item.Path && providerAttributeValue(item.Path, 'imdbid');
  if (imdb) item.ProviderIds.Imdb = imdb;
  return item;
}

/** ResolverHelper initialization happens before repository saving. Directory
 * metadata has native minimum timestamps, so its creation time uses UTC now.
 * This preserves file Int64 sizes and all seven fractional date digits. */
export function setResolverInitialValues(item, { identityPath, entry, parent, parents = [],
  metadataConfiguration = { UseFileCreationTimeForDateAdded: true }, clock = () => new Date() } = {}) {
  item.Path ||= identityPath;
  if (parent) item.ParentId = parent.Id;
  item.Name ||= entry.kind === 'directory' ? entry.name : nativeFileNameWithoutExtension(entry.name);
  item.IsLocked = attributeIndex(item.Path, '[dontfetchmeta]') >= 0
    || [parent, ...parents].some(value => value?.IsLocked === true);
  const created = entry.kind === 'directory' ? MIN_DATE : dateText(normalizeProbeFileDate(entry.created ?? MIN_DATE));
  item.DateCreated = !metadataConfiguration.UseFileCreationTimeForDateAdded || created === MIN_DATE
    ? dateText(nativeDate(clock())) : created;
  item.DateModified = entry.kind === 'directory' ? MIN_DATE : dateText(normalizeProbeFileDate(entry.modified ?? MIN_DATE));
  if (entry.kind === 'file') item.Size = entry.size ?? null;
  return setResolverProviderIdsFromPath(item);
}
