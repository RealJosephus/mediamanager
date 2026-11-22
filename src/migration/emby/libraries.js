import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaultLibraryOptions, parseLibraryOptions } from '../../library/options.js';
import { serializeLibraryOptions } from '../../library/library-options-store.js';
import { decodeConfigurationXml } from '../../core/configuration-xml.js';
import { exists } from './files.js';
import { itemTypes } from './format.js';

const keys = [
  'EnableRealtimeMonitor',
  'EnableChapterImageExtraction',
  'ExtractChapterImagesDuringLibraryScan',
  'SaveLocalMetadata',
  'PreferredMetadataLanguage',
  'MetadataCountryCode',
  'MetadataSavers',
  'SubtitleDownloadLanguages',
  'EnableEmbeddedTitles',
  'SaveSubtitlesWithMedia',
];
export function commonLibraryOptions(value = {}) {
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]));
}
function filename(instance, folder) {
  const candidate = folder.Path ? path.win32.basename(folder.Path) : folder.Name;
  if (!candidate || candidate === '.' || candidate === '..' || /[\\/:]/u.test(candidate))
    throw new Error('Cannot identify the options directory for ' + folder.Name);
  return path.join(instance, 'data', 'root', 'default', candidate, 'options.xml');
}
export async function readJellyfinLibraryOptions(view, instance) {
  for (const [key, row] of view.rows) {
    if (!key.startsWith('item/') || row.type !== itemTypes[4]) continue;
    const file = filename(instance, row);
    const options = (await exists(file))
      ? parseLibraryOptions(decodeConfigurationXml(await readFile(file)))
      : defaultLibraryOptions();
    row.Options = commonLibraryOptions(options);
    if (options.PathInfos?.length) row.Locations = options.PathInfos.map((p) => p.Path).filter(Boolean);
  }
}
export async function writeJellyfinLibraryOptions(changes, instance) {
  for (const { key, value, fields } of changes) {
    if (
      !key.startsWith('item/') ||
      value?.type !== itemTypes[4] ||
      !fields.some((f) => ['Options', 'Locations'].includes(f))
    )
      continue;
    const file = filename(instance, value);
    const previous = (await exists(file))
      ? parseLibraryOptions(decodeConfigurationXml(await readFile(file)))
      : defaultLibraryOptions();
    if (fields.includes('Options')) Object.assign(previous, value.Options);
    if (fields.includes('Locations'))
      previous.PathInfos = value.Locations.map(
        (name) => previous.PathInfos?.find((p) => p.Path === name) ?? { Path: name },
      );
    const { bytes, failure } = serializeLibraryOptions(previous);
    if (failure) throw failure;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes);
  }
}
