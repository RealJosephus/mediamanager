import { imagePathApi } from './image-assets.js';
import { containingImageFolder, internalImagePath } from './image-paths.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.tbn', '.gif', '.svg'];
const same = (a, b) => ordinalIgnoreCaseKey(a) === ordinalIgnoreCaseKey(b);
export async function scanLocalImages(loaded, { signal } = {}) {
  const { item, imageAssets: assets } = loaded, api = imagePathApi(item.Path || loaded.metadataPath), images = [];
  const list = async (folder, directories = true) => {
    if (!folder) return [];
    try { return (await assets.list(folder, { signal })).filter(file => directories && file.kind === 'directory' || extensions.some(extension => same(extension, api.extname(file.Path))))
      .sort((a, b) => extensions.indexOf(api.extname(a.Path)) - extensions.indexOf(api.extname(b.Path))); }
    catch (error) { if (error.code === 'not-found') return []; throw error; }
  };
  const add = (files, name, Type) => {
    const file = files.find(file => file.kind !== 'directory' && file.size > 0 && same(api.basename(file.Path, api.extname(file.Path)), name));
    if (file) images.push({ ...file, Type }); return Boolean(file);
  };
  const populate = async (files, parentSeries) => {
    if (parentSeries && item.Type === 'Season' && item.IndexNumber != null && loaded.series?.Path) {
      const seriesFiles = await list(loaded.series.Path, false), prefix = item.Name.replaceAll(' ', '').toLowerCase();
      const marker = item.IndexNumber === 0 ? '-specials' : item.IndexNumber < 0 ? '-' + String(-item.IndexNumber).padStart(2, '0') : String(item.IndexNumber).padStart(2, '0');
      for (const name of [prefix, ...(!same(prefix, marker) ? ['season' + marker] : [])]) for (const [suffix, type] of [['poster', 'Primary'], ['fanart', 'Backdrop'], ['banner', 'Banner'], ['landscape', 'Thumb']]) add(seriesFiles, `${name}-${suffix}`, type);
    }
    const fileName = item.Path ? api.basename(item.Path, api.extname(item.Path)) : '', prefix = fileName + '-', mixed = item.IsInMixedFolder;
    const names = ['MusicAlbum', 'MusicArtist', 'PhotoAlbum'].includes(item.Type) ? ['folder', 'poster', 'cover', 'jacket', 'default', 'albumart']
      : item.Type === 'Person' ? ['folder', 'poster'] : item.Type === 'Series' ? ['poster', 'folder', 'cover', 'default', 'show']
        : ['Movie', 'Video', 'MusicVideo', 'Trailer'].includes(item.Type) ? ['poster', 'folder', 'cover', 'default', 'movie'] : ['poster', 'folder', 'cover', 'default'];
    if (!(fileName && add(files, fileName, 'Primary')) && !names.some(name => add(files, prefix + name, 'Primary')) && !mixed) names.some(name => add(files, name, 'Primary'));
    const pair = (name, type) => { const prefixed = add(files, prefix + name, type); return (!mixed && add(files, name, type)) || prefixed; };
    const ordinary = !['Episode', 'Audio', 'Person'].includes(item.Type);
    if (ordinary) { if (!pair('logo', 'Logo')) pair('clearlogo', 'Logo'); pair('clearart', 'Art'); }
    if (item.Type === 'MusicAlbum') { if (!pair('cdart', 'Disc')) pair('disc', 'Disc'); }
    else if (['Movie', 'Video', 'MusicVideo', 'Trailer', 'Episode', 'BoxSet'].includes(item.Type)) { if (!pair('disc', 'Disc') && !pair('cdart', 'Disc')) pair('discart', 'Disc'); }
    if (!ordinary) return;
    pair('banner', 'Banner'); if (!pair('landscape', 'Thumb')) pair('thumb', 'Thumb');
    if (fileName) { add(files, prefix + fileName + '-fanart', 'Backdrop'); if (!mixed) add(files, fileName + '-fanart', 'Backdrop'); }
    const backdrops = (first, numbered) => {
      for (const namePrefix of [prefix, ...(!mixed ? [''] : [])]) {
        add(files, namePrefix + first, 'Backdrop'); let missing = 0;
        for (let i = 1; i <= 20; i++) if (!add(files, namePrefix + numbered + i, 'Backdrop') && ++missing >= 3) break;
      }
    };
    for (const name of ['fanart', 'background', 'art']) backdrops(name, name + '-');
    const extra = files.find(file => same(file.name, 'extrafanart'));
    if (extra) for (const file of await list(extra.Path, false)) if (file.size > 0) images.push({ ...file, Type: 'Backdrop' });
    backdrops('backdrop', 'backdrop');
  };
  if (item.SupportsLocalMetadata && item.Type === 'Episode') {
    const parent = api.dirname(item.Path), base = api.basename(item.Path, api.extname(item.Path));
    const files = await list(parent);
    const addEpisode = files => { for (const file of files) if (file.kind !== 'directory' && [base, base + '-thumb'].some(name => same(name, api.basename(file.Path, api.extname(file.Path))))) images.push({ ...file, Type: 'Primary' }); };
    // Episode provider keeps directory enumeration order and permits zero-length files.
    let unsorted; try { unsorted = await assets.list(parent, { signal }); } catch (error) { if (error.code !== 'not-found') throw error; unsorted = []; }
    addEpisode(unsorted.filter(file => extensions.some(extension => same(extension, api.extname(file.Path)))));
    const metadata = files.find(file => file.kind === 'directory' && file.name === 'metadata');
    if (metadata) addEpisode((await assets.list(metadata.Path, { signal })).filter(file => extensions.some(extension => same(extension, api.extname(file.Path)))));
  } else if (item.SupportsLocalMetadata && !['Audio', 'Photo'].includes(item.Type) || item.Type === 'Season' && item.LocationType === 'Virtual' && loaded.series?.Path) {
    await populate(item.IsFileProtocol ? await list(containingImageFolder(item)) : [], true);
  }
  if (loaded.metadataPath && item.Type !== 'Photo' && (!loaded.saveLocalMetadataEnabled || item.Type === 'Audio' || !item.SupportsLocalMetadata || item.Type === 'PhotoAlbum')) {
    await populate(await list(internalImagePath(item, loaded.metadataPath), false), false);
  }
  return images;
}
