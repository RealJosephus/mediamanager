import { imagePathApi } from './image-assets.js';
import { dateTicks } from '../library/records.js';
import { parseOpfDocument, readOpfMetadata } from './opf-reader.js';

const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
const noMetadata = () => ({ HasMetadata: false, Item: null, People: null, ResultLanguage: null });
export function createBookOpfPlugin({ fileSystem, logger = { error() {} } } = {}) {
  if (!fileSystem?.stat || !fileSystem?.readFile) throw new TypeError('Book OPF requires metadata filesystem access.');
  const locate = async (item, context) => {
    if (typeof context.fileSystemMetadata !== 'function') throw new TypeError('Book OPF requires original file shape metadata.');
    const shape = await context.fileSystemMetadata(), api = imagePathApi(item.Path);
    const directory = shape?.kind === 'directory' ? item.Path : api.dirname(item.Path);
    for (const name of [api.basename(item.Path, api.extname(item.Path)) + '.opf', 'content.opf', 'metadata.opf']) {
      const filename = api.join(directory, name);
      try { const info = await fileSystem.stat(filename, { bigint: true }); if (info.isFile()) return { filename, info }; }
      catch (error) { if (!missing(error)) throw error; }
      if (name === 'metadata.opf') return { filename, info: null };
    }
  };
  const provider = { id: 'book-opf', name: 'Open Packaging Format', kind: 'local', order: 50, itemTypes: ['Book'],
    async hasChanged(item, context = {}) {
      const file = await locate(item, context); if (!file.info) return false;
      const modified = file.info.mtimeNs != null ? 621355968000000000n + file.info.mtimeNs / 100n : dateTicks(file.info.mtime);
      return modified > dateTicks(item.DateLastSaved);
    },
    async getMetadata(item, context = {}) {
      const file = await locate(item, context);
      context.signal?.throwIfAborted();
      try { return readOpfMetadata(parseOpfDocument(await fileSystem.readFile(file.filename)), { signal: context.signal, logger }); }
      catch (error) {
        if (error.nativeException === 'FileNotFoundException') return noMetadata();
        if (!['ENOENT', 'not-found'].includes(error.code)) throw error;
        try { if (!(await fileSystem.stat(imagePathApi(file.filename).dirname(file.filename))).isDirectory()) throw Object.assign(error, { nativeException: 'DirectoryNotFoundException' }); }
        catch (parentError) { if (missing(parentError)) throw Object.assign(error, { nativeException: 'DirectoryNotFoundException' }); throw parentError; }
        return noMetadata();
      }
    }
  };
  return { id: 'builtin-book-opf', name: 'Book Open Packaging Format', providers: [provider] };
}
