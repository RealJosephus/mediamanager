import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const source = path.resolve(process.argv[2] ?? 'D:/jellyfin');
const destination = path.resolve('src/library/resources');
const keys = ['HeaderContinueWatching', 'Latest', 'Movies', 'Collections', 'Favorites', 'Genres',
  'HeaderNextUp', 'Shows', 'HeaderFavoriteShows', 'HeaderFavoriteEpisodes', 'TvShows', 'Folders'];
const sourceFiles = [];
async function readSource(relative) {
  const bytes = await readFile(path.join(source, relative));
  sourceFiles.push({ path: relative.replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex') });
  return bytes;
}
const root = 'Emby.Server.Implementations/Localization';
const labels = {};
for (const filename of (await readdir(path.join(source, root, 'Core'))).filter(name => name.endsWith('.json')).sort()) {
  const values = JSON.parse((await readSource(`${root}/Core/${filename}`)).toString('utf8').replace(/^\uFEFF/, ''));
  labels[filename.slice(0, -5)] = Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]));
}
for (const relative of [`${root}/LocalizationManager.cs`, 'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'MediaBrowser.Controller/Entities/UserView.cs', 'Emby.Server.Implementations/Library/UserViewManager.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs']) await readSource(relative);
await writeFile(path.join(destination, 'user-view-labels.json'), JSON.stringify(labels, null, 2) + '\n');
await writeFile(path.join(destination, 'user-view-labels-provenance.json'), JSON.stringify({ source, license: 'GPL-2.0-only',
  extraction: 'tests/library/extract-user-view-resources.js', sourceFiles }, null, 2) + '\n');
console.log(JSON.stringify({ cultures: Object.keys(labels).length, keys: keys.length, sourceFiles: sourceFiles.length }));
