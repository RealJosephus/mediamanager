import path from 'node:path';

export function nfoPaths(item, { accessPath = item.Path, containingFolderPath, seriesPath, seriesSeason = false } = {}) {
  if (!accessPath?.startsWith('/')) throw new TypeError('An absolute VFS access path is required for NFO access.');
  const containing = containingFolderPath ?? (['Dvd', 'BluRay'].includes(item.VideoType) && !item.IsPlaceHolder ? accessPath : path.posix.dirname(accessPath));
  const changeExtension = (value) => value.slice(0, value.length - path.posix.extname(value).length) + '.nfo';
  if (seriesSeason) return [path.posix.join(accessPath, 'tvshow.nfo'), ...(seriesPath ? [path.posix.join(seriesPath, 'tvshow.nfo')] : [])];
  const names = { Series: 'tvshow.nfo', Season: 'season.nfo', MusicAlbum: 'album.nfo', MusicArtist: 'artist.nfo' };
  if (names[item.Type]) return [path.posix.join(accessPath, names[item.Type])];
  if (item.Type === 'Episode') return [changeExtension(accessPath)];
  if (!['Movie', 'Video', 'MusicVideo'].includes(item.Type)) throw new TypeError(`Unsupported NFO item type: ${item.Type}`);
  const result = [];
  if (item.VideoType === 'Dvd' && !item.IsPlaceHolder) result.push(path.posix.join(containing, 'VIDEO_TS', 'VIDEO_TS.nfo'));
  if (!item.IsInMixedFolder && item.Type === 'Movie') result.push(path.posix.join(containing, 'movie.nfo'));
  result.push(!item.IsPlaceHolder && ['Dvd', 'BluRay'].includes(item.VideoType) ? path.posix.join(containing, path.posix.basename(containing) + '.nfo') : changeExtension(accessPath));
  return result;
}

// File access and directory monitoring use different namespaces. Keep the
// sidecar's relative location, but report it beside the item's identity path.
export function nfoMonitorPath(item, context = {}) {
  const accessPath = context.accessPath ?? item.Path;
  const relative = path.posix.relative(accessPath, nfoPaths(item, context)[0]);
  const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? path.win32 : path.posix;
  return api.resolve(item.Path, ...relative.split('/'));
}

const timestamp = value => value == null ? -62135596800000 : new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
  ? value.replace(' ', 'T') + 'Z' : value).valueOf();
export const nfoHasChanged = (modified, dateLastSaved) => timestamp(modified) - timestamp(dateLastSaved) > 60_000;
