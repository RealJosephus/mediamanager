import { imagePathApi } from './image-assets.js';
import { parseOpfDocument, readOpfMetadata, readOpfCoverPath, readEpubContentPath } from './opf-reader.js';

const noMetadata = () => ({ HasMetadata: false, Item: null, People: null, ResultLanguage: null });
const isEpub = item => imagePathApi(item.Path).extname(item.Path ?? '').toLowerCase() === '.epub';
const formatMimeType = mimeType => /gif$/iu.test(mimeType) ? 'image/gif' : /bmp$/iu.test(mimeType) ? 'image/bmp' : /png$/iu.test(mimeType) ? 'image/png' : 'image/jpeg';
const directoryName = filename => {
  const separator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  return separator < 0 ? '' : filename.slice(0, separator).replaceAll('/', '\\');
};

export function createBookEpubPlugin({ openArchive, logger = { error() {} } } = {}) {
  if (typeof openArchive !== 'function') throw new TypeError('Book EPUB requires original-media archive access.');
  const metadata = { id: 'book-epub', name: 'EPUB Metadata', kind: 'local', order: 50, itemTypes: ['Book'],
    async getMetadata(item, context = {}) {
      if (typeof context.fileSystemMetadata !== 'function') throw new TypeError('Book EPUB requires original file shape metadata.');
      const shape = await context.fileSystemMetadata();
      if (shape?.kind === 'directory' || !isEpub(item)) return noMetadata();
      // The synchronous native metadata prefix does not use the request token.
      // Cancellation is first checked by OpfReader after XML loading.
      const archive = await openArchive(item, { zipOnly: true });
      try {
        const container = archive.findEntry('META-INF\\container.xml'); if (!container) return noMetadata();
        const filename = readEpubContentPath(parseOpfDocument(await archive.read(container)));
        if (filename == null) return noMetadata();
        const entry = archive.findEntry(filename); if (!entry) return noMetadata();
        return readOpfMetadata(parseOpfDocument(await archive.read(entry)), { signal: context.signal, logger });
      } finally { await archive.close(); }
    }
  };
  const cover = { id: 'book-epub-cover', name: 'EPUB Metadata', kind: 'image', imageSource: 'dynamic', order: 50,
    itemTypes: ['Book'], imageTypes: ['Primary'],
    async getImage(item, { signal } = {}) {
      if (!isEpub(item)) return null;
      signal?.throwIfAborted();
      const archive = await openArchive(item, { signal, zipOnly: true });
      try {
        const container = archive.findEntry('META-INF\\container.xml'); if (!container) return null;
        const filename = readEpubContentPath(parseOpfDocument(await archive.read(container)));
        if (filename == null) return null;
        const entry = archive.findEntry(filename); if (!entry) return null;
        const reference = readOpfCoverPath(parseOpfDocument(await archive.read(entry, { signal })), directoryName(filename));
        if (!reference) return null;
        const image = archive.findEntry(reference.path); if (!image) return null;
        return { bytes: await archive.read(image, { signal }), mimeType: formatMimeType(reference.mimeType) };
      } finally { await archive.close(); }
    }
  };
  return { id: 'builtin-book-epub', name: 'Book EPUB', providers: [metadata, cover] };
}
