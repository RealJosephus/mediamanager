import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSavePaths } from '../../src/metadata/image-paths.js';

const Id = 'db120000-0000-0000-0000-000000000001';
const cases = [
  { media: 'Z:\\Books\\book.cbz', metadata: '/state/metadata',
    internal: '/state/metadata/library/db/db120000000000000000000000000001',
    separator: '/', local: 'Z:\\Books\\folder.png' },
  { media: '/media/books/book.cbz', metadata: 'C:\\State\\metadata',
    internal: 'C:\\State\\metadata\\library\\db\\db120000000000000000000000000001',
    separator: '\\', local: '/media/books/folder.png' },
];

test('internal image destinations use the metadata directory style independently of the media identity', () => {
  for (const sample of cases) {
    const item = { Id, Type: 'Book', Path: sample.media };
    assert.deepEqual(imageSavePaths(item, 'Primary', null, 'image/png', {
      saveLocally: false, metadataPath: sample.metadata,
    }), [sample.internal + sample.separator + 'poster.png']);
    assert.deepEqual(imageSavePaths(item, 'Primary', null, 'image/png', {
      saveLocally: true, metadataPath: sample.metadata,
    }), [sample.local], 'media sidecars retain the media identity style');
  }
});

test('internal backdrop numbering recognizes existing destination filenames in either path style', () => {
  for (const sample of cases) {
    const images = ['backdrop.png', 'BACKDROP1.PNG'].map(filename => ({
      Type: 'Backdrop', Path: sample.internal + sample.separator + filename,
    }));
    assert.deepEqual(imageSavePaths({ Id, Type: 'Book', Path: sample.media }, 'Backdrop', 1, 'image/png', {
      saveLocally: false, metadataPath: sample.metadata, images,
    }), [sample.internal + sample.separator + 'backdrop2.png']);
  }
});
