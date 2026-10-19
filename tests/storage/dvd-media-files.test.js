import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { getDvdMediaFiles, verifyDvdMediaFiles } from '../../src/storage/dvd-media-files.js';
import { externalCandidates } from '../../src/storage/external-streams.js';

async function fixture(t) {
  const registry = new StorageRegistry();
  t.after(() => registry.close());
  registry.registerType('dvd-test', () => new MemoryStorageAdapter({ pageSize: 2 }));
  const adapter = await registry.createInstance('dvd', 'dvd-test', {});
  await adapter.mkdir('/Movie.Edition'); await adapter.mkdir('/Movie.Edition/VIDEO_TS');
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'dvd', capabilities: {} });
  return { adapter, vfs, root: '/media/Movie.Edition',
    write: (name, bytes = Buffer.from(name)) => adapter.write('/Movie.Edition/VIDEO_TS/' + name, bytes) };
}

test('DVD selection recursively excludes menus and selects the native final underscore component', async t => {
  const f = await fixture(t);
  for (const name of ['VTS_02_1.VOB', 'VTS_01_2.vob', 'VIDEO_TS.VOB', 'VTS_01_0.VOB', 'VTS_01_1.VOB']) await f.write(name);
  await f.adapter.mkdir('/Movie.Edition/VIDEO_TS/nested');
  await f.write('nested/VTS_03_1.vob');
  const names = files => files.map(file => file.virtualPath.slice(f.root.length + 1));
  assert.deepEqual(names(await getDvdMediaFiles(f.vfs, f.root)),
    ['VIDEO_TS/nested/VTS_03_1.vob', 'VIDEO_TS/VTS_01_1.VOB', 'VIDEO_TS/VTS_02_1.VOB']);
  assert.deepEqual(names(await getDvdMediaFiles(f.vfs, f.root, { titleNumber: 1 })),
    ['VIDEO_TS/VTS_01_1.VOB', 'VIDEO_TS/VTS_01_2.vob']);
  assert.deepEqual(names(await getDvdMediaFiles(f.vfs, f.root, { titleNumber: 99 })),
    names(await getDvdMediaFiles(f.vfs, f.root)));
  const stat = f.vfs.stat.bind(f.vfs);
  f.vfs.stat = async (filename, options) => ({ ...await stat(filename, options),
    ...(filename.endsWith('VTS_01_2.vob') ? { size: 900n * 1024n * 1024n } : {}) });
  assert.deepEqual(names(await getDvdMediaFiles(f.vfs, f.root)), ['VIDEO_TS/VTS_01_2.vob']);
  f.vfs.stat = async (filename, options) => ({ ...await stat(filename, options), size: null });
  await assert.rejects(getDvdMediaFiles(f.vfs, f.root), { code: 'not-supported' });
  assert.deepEqual(names(await getDvdMediaFiles(f.vfs, f.root, { titleNumber: 1 })),
    ['VIDEO_TS/VTS_01_1.VOB', 'VIDEO_TS/VTS_01_2.vob']);
});

test('DVD source verification ignores unrelated writes but rejects file replacement and selection changes', async t => {
  const f = await fixture(t);
  await f.write('VTS_01_1.VOB'); await f.write('VTS_02_1.VOB');
  const before = await getDvdMediaFiles(f.vfs, f.root);
  await f.adapter.write('/Movie.Edition/movie.nfo', Buffer.from('<movie/>'));
  await verifyDvdMediaFiles(f.vfs, f.root, before);
  await f.write('VTS_02_1.VOB', Buffer.from('replaced'));
  await assert.rejects(verifyDvdMediaFiles(f.vfs, f.root, before), { code: 'version-changed' });
  const current = await getDvdMediaFiles(f.vfs, f.root);
  await f.write('VTS_03_1.VOB');
  await assert.rejects(verifyDvdMediaFiles(f.vfs, f.root, current), { code: 'version-changed' });
  await f.adapter.delete('/Movie.Edition/VIDEO_TS');
  await assert.rejects(verifyDvdMediaFiles(f.vfs, f.root, current), { code: 'version-changed' });
});

test('DVD selection fails without playable VOBs and preserves cancellation', async t => {
  const f = await fixture(t);
  await f.write('VIDEO_TS.VOB'); await f.write('VTS_01_0.VOB');
  await assert.rejects(getDvdMediaFiles(f.vfs, f.root), { code: 'invalid-response' });
  const controller = new AbortController(), list = f.vfs.list.bind(f.vfs);
  f.vfs.list = async (...args) => { const result = await list(...args); controller.abort(); return result; };
  await assert.rejects(getDvdMediaFiles(f.vfs, f.root, { signal: controller.signal }), { code: 'cancelled' });
});

test('DVD external streams use the containing disc directory and full directory name', async t => {
  const f = await fixture(t);
  for (const name of ['Movie.Edition.en.srt', 'Movie.Edition.en.wav', 'Movie.en.srt']) {
    await f.adapter.write('/Movie.Edition/' + name, Buffer.from('fixture'));
  }
  await f.adapter.write('/Movie.Edition.en.srt', Buffer.from('outside the disc'));
  const options = { sourceIsDirectory: true, useFullFileName: true };
  const selected = await externalCandidates(f.vfs, f.root, 'Z:\\Movies\\Movie.Edition', options);
  assert.deepEqual(selected.map(file => [file.type, file.identityPath]), [
    ['Subtitle', 'Z:\\Movies\\Movie.Edition\\Movie.Edition.en.srt'],
    ['Audio', 'Z:\\Movies\\Movie.Edition\\Movie.Edition.en.wav']
  ]);
  const stacked = await externalCandidates(f.vfs, f.root, 'Z:\\Movies\\Movie.Edition', { useFullFileName: true });
  assert.deepEqual(stacked.map(file => file.identityPath), ['Z:\\Movies\\Movie.Edition.en.srt']);
});
