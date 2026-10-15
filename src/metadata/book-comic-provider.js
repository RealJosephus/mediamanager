import { imagePathApi } from './image-assets.js';
import { nativeFileNameWithoutExtension } from '../library/native-path.js';
import { dateTicks, MIN_DATE } from '../library/records.js';
import { formatUtcTicks } from '../syncplay/time.js';
import { comicHasText, parseComicInfoXml, readComicInfo } from './comic-info-reader.js';
import { readComicBookInfo } from './comic-book-info-reader.js';

const noMetadata = () => ({ HasMetadata: false });
const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
const comicExtensions = new Set(['.cb7', '.cbr', '.cbt', '.cbz']);
const coverExtensions = ['.png', '.jpeg', '.jpg', '.webp', '.bmp', '.gif'];
const mimeTypes = { '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };
const modified = stat => stat.modified ?? (stat.mtimeNs != null ? formatUtcTicks(621355968000000000n + BigInt(stat.mtimeNs) / 100n)
  : stat.mtime?.toISOString() ?? MIN_DATE);

export function createBookComicPlugin({ fileSystem, openArchive, logger = {}, culture } = {}) {
  const log = (level, error, message) => logger[level]?.(error, message);
  const mediaInfo = async (item, context) => {
    if (typeof context.fileSystemMetadata !== 'function') throw new TypeError('Comic metadata requires the scoped original-media file lookup.');
    return await context.fileSystemMetadata() ?? { exists: false, kind: 'file', modified: MIN_DATE };
  };
  const cbzFile = async (item, context) => {
    const file = await mediaInfo(item, context);
    return file.kind !== 'directory' && imagePathApi(item.Path).extname(item.Path).toLowerCase() === '.cbz' ? file : null;
  };
  const sidecar = async (item, context) => {
    const file = await mediaInfo(item, context), api = imagePathApi(item.Path);
    const directory = file.kind === 'directory' ? item.Path : api.dirname(item.Path);
    const lookup = async identity => {
      try { const info = await fileSystem.stat(identity); return { path: identity, exists: info.isFile?.() ?? info.kind === 'file', modified: modified(info) }; }
      catch (error) { if (missing(error)) return { path: identity, exists: false, modified: MIN_DATE }; throw error; }
    };
    const sameStem = await lookup(api.join(directory, nativeFileNameWithoutExtension(item.Path) + '.xml'));
    return sameStem.exists ? sameStem : lookup(api.join(directory, 'ComicInfo.xml'));
  };
  const commentMetadata = async (item, context) => {
    if (!await cbzFile(item, context)) { log('debug', null, 'No ComicBookInfo metadata found.'); return noMetadata(); }
    try {
      const archive = await openArchive(item, { signal: context.signal, zipOnly: true });
      try {
        const comment = Buffer.from(archive.comment).toString('utf8');
        if (!comicHasText(comment)) { log('debug', null, 'Missing ComicBookInfo in archive comment.'); return noMetadata(); }
        return readComicBookInfo(comment);
      } finally { await archive.close(); }
    } catch (error) { log(error.nativeException === 'JsonException' ? 'debug' : 'error', error, 'Could not read ComicBookInfo.'); return noMetadata(); }
  };
  const externalMetadata = async (item, context) => {
    const file = await sidecar(item, context);
    if (!file.exists) { log('debug', null, 'No external ComicInfo metadata found.'); return noMetadata(); }
    let document;
    try {
      let bytes;
      if (context.imageAssets?.openRead) {
        // XmlReader.Create opens the sidecar before XDocument observes cancellation.
        const handle = await context.imageAssets.openRead(file.path);
        try {
          context.signal?.throwIfAborted();
          const chunks = [];
          for await (const chunk of handle.stream) { context.signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
          bytes = Buffer.concat(chunks);
        } finally { await handle.close(); }
      } else bytes = await fileSystem.readFile(file.path, { signal: context.signal });
      context.signal?.throwIfAborted();
      document = parseComicInfoXml(bytes);
    } catch (error) { log('warn', error, 'Could not load external ComicInfo XML.'); log('debug', null, 'No external ComicInfo metadata found.'); return noMetadata(); }
    return readComicInfo(document);
  };
  const internalMetadata = async (item, context) => {
    if (!await cbzFile(item, context)) { log('debug', null, 'No internal ComicInfo metadata found.'); return noMetadata(); }
    let document;
    try {
      const archive = await openArchive(item, { signal: context.signal, zipOnly: true });
      try {
        const entry = archive.findEntry('ComicInfo.xml');
        if (!entry) { log('debug', null, 'No internal ComicInfo metadata found.'); return noMetadata(); }
        const bytes = await archive.read(entry, { signal: context.signal });
        context.signal?.throwIfAborted();
        document = parseComicInfoXml(bytes, { allowDtd: true, preserveWhitespace: false });
      } finally { await archive.close(); }
    } catch (error) { log('error', error, 'Could not load internal ComicInfo XML.'); log('debug', null, 'No internal ComicInfo metadata found.'); return noMetadata(); }
    return readComicInfo(document);
  };
  const metadataProvider = { id: 'comic-metadata', name: 'Comic Provider', kind: 'local', itemTypes: ['Book'],
    async hasChanged(item, context = {}) {
      const file = await cbzFile(item, context);
      if (file?.exists && dateTicks(file.modified) > dateTicks(item.DateLastSaved)) return true;
      const xml = await sidecar(item, context);
      if (xml.exists && dateTicks(xml.modified) > dateTicks(item.DateLastSaved)) return true;
      // The native third monitor checks the same CBZ file again.
      const internal = await cbzFile(item, context);
      return Boolean(internal?.exists && dateTicks(internal.modified) > dateTicks(item.DateLastSaved));
    },
    async getMetadata(item, context = {}) {
      for (const read of [commentMetadata, externalMetadata, internalMetadata]) {
        const result = await read(item, context);
        if (result.HasMetadata) return result;
      }
      return noMetadata();
    }
  };
  const coverProvider = { id: 'comic-cover', name: 'Comic Book Archive Cover Extractor', kind: 'image', imageSource: 'dynamic',
    itemTypes: ['Book'], imageTypes: ['Primary'],
    async getImage(item, { signal } = {}) {
      if (typeof item.Path !== 'string' || !comicExtensions.has(imagePathApi(item.Path).extname(item.Path).toLowerCase())) return null;
      try {
        const archive = await openArchive(item, { signal });
        try {
          let cover = null;
          for (const extension of coverExtensions) { cover = archive.findEntry('cover' + extension); if (cover) break; }
          if (!cover) {
            const comparer = new Intl.Collator(typeof culture === 'function' ? culture() : culture, { sensitivity: 'variant', numeric: false });
            cover = archive.entries.filter(entry => typeof entry.key === 'string' && coverExtensions.includes(imagePathApi(entry.key).extname(entry.key).toLowerCase()))
              .toSorted((a, b) => comparer.compare(a.key, b.key))[0];
          }
          if (!cover) throw new Error('No supported comic cover found.');
          const bytes = await archive.read(cover, { signal });
          return { bytes, mimeType: mimeTypes[imagePathApi(cover.key).extname(cover.key).toLowerCase()] };
        } finally { await archive.close(); }
      } catch (error) { log('error', error, 'Could not load comic cover.'); return null; }
    }
  };
  return { id: 'builtin-book-comic', name: 'Comic Books', providers: [metadataProvider, coverProvider] };
}
