import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataImages } from '../../src/metadata/images.js';

const id = '22222222-2222-2222-2222-222222222222';
const internal = '/metadata/library/22/' + id.replaceAll('-', '');
const source = { bytes: Buffer.from('image bytes'), mimeType: 'image/png', Type: 'Primary' };

function fixture(t, { writeFailure, deleteFailure } = {}) {
  const active = new Set(), completed = [], files = new Map(), writes = [], deletes = [];
  const monitor = {
    reportFileSystemChangeBeginning(filename) { active.add(filename); },
    reportFileSystemChangeComplete(filename, refresh) { active.delete(filename); completed.push({ filename, refresh }); }
  };
  const imageAssets = {
    async write(filename, bytes, options = {}) {
      assert.ok(active.has(filename), 'The image must be suppressed before writing.');
      assert.ok(active.has(filename.slice(0, filename.lastIndexOf('/'))), 'Creating the parent directory must be suppressed.');
      writes.push({ filename, length: bytes.length });
      if (writeFailure) await writeFailure(filename, bytes, options);
      options.signal?.throwIfAborted();
      files.set(filename, Buffer.from(bytes));
      return { Path: filename, modified: '2024-01-02T00:00:00Z' };
    },
    async delete(filename) {
      assert.ok(active.has(filename), 'The old image must be suppressed before removal.');
      deletes.push(filename);
      if (deleteFailure) throw deleteFailure;
      files.delete(filename);
    }
  };
  const service = new MetadataImages({ monitor });
  t.after(() => service.close());
  const loaded = { item: { Id: id, Type: 'Movie', Path: '/media/movie.mkv', IsFileProtocol: true,
    SupportsLocalMetadata: true }, imageAssets, metadataPath: '/metadata', saveLocalMetadataEnabled: true,
    globalOptions: { ImageSavingConvention: 'Compatible' },
    capturePathScope() { return { metadataPath: this.metadataPath, imageAssets: this.imageAssets }; } };
  return { service, loaded, active, completed, files, writes, deletes };
}

test('image saves suppress both created paths and old image removal, then publish the replacement', async t => {
  const f = fixture(t);
  const images = [{ Type: 'Primary', Path: '/media/old.jpg', Width: 100, Height: 200 }];
  await f.service.saveImage(f.loaded, images, source);
  assert.deepEqual(f.writes, [{ filename: '/media/poster.png', length: 0 }, { filename: '/media/poster.png', length: source.bytes.length }]);
  assert.deepEqual(f.deletes, ['/media/old.jpg']);
  assert.deepEqual(f.files.get('/media/poster.png'), source.bytes);
  assert.equal(images[0].Path, '/media/poster.png');
  assert.equal(images[0].Width, 0);
  assert.equal(f.active.size, 0);
  assert.ok(f.completed.every(value => value.refresh === false));
});

test('failed local writes release suppression before retrying internal image storage', async t => {
  const f = fixture(t, { writeFailure: filename => {
    if (filename.startsWith('/media/')) throw Object.assign(new Error('Read-only mount'), { code: 'permission-denied' });
    assert.ok(!f.active.has('/media/poster.png') && !f.active.has('/media'));
  } });
  const images = [];
  await f.service.saveImage(f.loaded, images, source);
  assert.equal(images[0].Path, internal + '/poster.png');
  assert.deepEqual(f.files.get(images[0].Path), source.bytes);
  assert.equal(f.active.size, 0);
});

test('cancellation after truncate preserves its file side effect but releases suppression and associations', async t => {
  const controller = new AbortController();
  const f = fixture(t, { writeFailure: (filename, bytes) => { if (bytes.length) controller.abort(); } });
  const original = { Type: 'Primary', Path: '/media/old.jpg', Width: 100, Height: 200 };
  const images = [{ ...original }];
  await assert.rejects(f.service.saveImage(f.loaded, images, source, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.files.get('/media/poster.png'), Buffer.alloc(0));
  assert.deepEqual(images, [original]);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.active.size, 0);
});

test('old image deletion errors keep the saved replacement and release suppression', async t => {
  const error = new Error('Cannot delete old image');
  const f = fixture(t, { deleteFailure: error });
  const images = [{ Type: 'Primary', Path: '/media/old.jpg' }];
  await assert.rejects(f.service.saveImage(f.loaded, images, source), { message: error.message });
  assert.equal(images[0].Path, '/media/poster.png');
  assert.deepEqual(f.files.get(images[0].Path), source.bytes);
  assert.equal(f.active.size, 0);
});
