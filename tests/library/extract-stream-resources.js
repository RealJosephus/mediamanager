import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const source = path.resolve(process.argv[2] ?? 'D:/jellyfin');
const destination = path.resolve('src/library/resources');
const sourceFiles = [];
async function readSource(relative) {
  const data = await readFile(path.join(source, relative));
  sourceFiles.push({ path: relative.replaceAll('\\', '/'), sha256: createHash('sha256').update(data).digest('hex') });
  return data;
}
const root = 'Emby.Server.Implementations/Localization';
const languages = await readSource(`${root}/iso6392.txt`);
await writeFile(path.join(destination, 'iso6392.txt'), languages);
const phrases = {};
for (const filename of (await readdir(path.join(source, root, 'Core'))).filter(name => name.endsWith('.json')).sort()) {
  const values = JSON.parse((await readSource(`${root}/Core/${filename}`)).toString('utf8').replace(/^\uFEFF/, ''));
  phrases[filename.slice(0, -5)] = Object.fromEntries(['Default', 'External', 'Original', 'Undefined', 'Forced', 'HearingImpaired'].filter(key => key in values).map(key => [key, values[key]]));
}
await writeFile(path.join(destination, 'stream-phrases.json'), JSON.stringify(phrases, null, 2) + '\n');
for (const relative of ['Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs', 'MediaBrowser.Model/Entities/MediaStream.cs', 'Emby.Server.Implementations/Library/MediaStreamSelector.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs', 'Emby.Server.Implementations/Dto/DtoService.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs', 'MediaBrowser.Model/Configuration/LibraryOptions.cs', 'MediaBrowser.Model/Configuration/TypeOptions.cs', 'MediaBrowser.Model/Configuration/MediaPathInfo.cs', 'MediaBrowser.Model/Configuration/ImageOption.cs', 'MediaBrowser.Model/Configuration/EmbeddedSubtitleOptions.cs', 'Emby.Server.Implementations/ApplicationHost.cs']) await readSource(relative);
await writeFile(path.join(destination, 'provenance.json'), JSON.stringify({ source, license: 'GPL-2.0-only', extraction: 'tests/library/extract-stream-resources.js', sourceFiles }, null, 2) + '\n');
console.log(JSON.stringify({ cultures: Object.keys(phrases).length, sourceFiles: sourceFiles.length }));
