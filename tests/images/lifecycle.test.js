import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ImageService } from '../../src/images/service.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const stamp = '2024-01-01T00:00:00Z';

test('PostgreSQL image persistence uses two set writes and publishes its committed baseline before releasing the writer', async t => {
  const database = await createPostgresTestDatabase(t, 'image_writes');
  const store = new DomainStore(database);
  const itemId = '11111111-1111-1111-1111-111111111111';
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Image owner',
  }));
  await database.insertBatch('BaseItemImageInfos', [
    { Id: '21111111-1111-1111-1111-111111111111', ItemId: itemId, ImageType: 0,
      Path: '/old.jpg', DateModified: stamp, Width: 10, Height: 20, Blurhash: null },
    { Id: '31111111-1111-1111-1111-111111111111', ItemId: itemId, ImageType: 4,
      Path: '/removed.png', DateModified: stamp, Width: 30, Height: 40, Blurhash: null },
  ]);
  let rows = await store.run(db => readItemImageRows(db, itemId));
  let writerActive = false, publications = 0;
  const calls = [], write = store.serializeWrites.bind(store), transact = store.transaction.bind(store);
  store.serializeWrites = (operation, options) => write(async db => {
    writerActive = true;
    try { return await operation(db); }
    finally { writerActive = false; }
  }, options);
  store.transaction = (operation, options) => transact(async db => {
    const remove = db.deleteWhere.bind(db), insert = db.insertBatch.bind(db);
    db.deleteWhere = async (table, where) => { calls.push(['deleteWhere', table]); return remove(table, where); };
    db.insertBatch = async (table, values) => { calls.push(['insertBatch', table, values.length]); return insert(table, values); };
    try { return await operation(db); }
    finally { db.deleteWhere = remove; db.insertBatch = insert; }
  }, options);
  const loaded = {
    item: { Id: itemId },
    images: [
      { Id: rows[0].Id, Type: 'Primary', Path: '/new.jpg', DateModified: stamp, Width: 50, Height: 60 },
      { Type: 'Logo', Path: '/new.png', DateModified: stamp, Width: 70, Height: 80 },
    ],
  };
  Object.defineProperty(loaded, 'rows', {
    get: () => rows,
    set: value => {
      assert.equal(writerActive, true, 'the committed baseline must publish inside the writer boundary');
      publications++;
      rows = value;
    },
  });
  const service = new ImageService({fileSystem: testFileSystem,  store, processor: {}, metadataImages: { async close() {} }, metadataUpdates: {} });
  t.after(() => service.close());
  await service.persist(loaded);
  assert.deepEqual(calls, [
    ['deleteWhere', 'BaseItemImageInfos'], ['insertBatch', 'BaseItemImageInfos', 2],
  ]);
  assert.equal(publications, 1);
  assert.equal(loaded.images.every(image => typeof image.Id === 'string'), true);
  assert.deepEqual(rows.map(row => row.Path), ['/new.jpg', '/new.png']);
  assert.deepEqual(await store.run(db => readItemImageRows(db, itemId)), rows);
});

test('image shutdown waits for delayed VFS handle cleanup', async () => {
  const opened = Promise.withResolvers(), release = Promise.withResolvers();
  let closeStarted = false, closeFinished = false, serviceFinished = false;
  const service = new ImageService({fileSystem: testFileSystem,  processor: { async process() { return { original: true, path: '/image.png', mimeType: 'image/png', dateModified: stamp }; } } });
  const image = { Path: '/image.png', Type: 'Primary', DateModified: stamp };
  const loaded = { item: {}, imageAssets: {
    async stat() { return { size: 1n, modified: stamp }; },
    async openRead(_path, { signal }) {
      return {
        stream: (async function* () {
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            opened.resolve();
          });
        })(),
        async close() { closeStarted = true; await release.promise; closeFinished = true; },
      };
    },
  } };
  const request = Object.assign(new EventEmitter(), { method: 'GET', headers: {} });
  const response = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, appendHeader() {}, write() { return true; }, end() {}, destroy() { this.emit('close'); } });
  const sending = service.result({ loaded, image, options: {}, context: { query: new URLSearchParams() }, index: 0 }).send(request, response);
  await opened.promise;
  const stopping = service.close().then(() => { serviceFinished = true; });
  try {
    await nextTurn(); assert.equal(closeStarted, true); assert.equal(closeFinished, false); assert.equal(serviceFinished, false);
  } finally { release.resolve(); await Promise.all([sending, stopping]); }
  assert.equal(closeFinished, true); assert.equal(serviceFinished, true);
  assert.equal(request.listenerCount('aborted'), 0); assert.equal(response.listenerCount('close'), 0);
});

test('image shutdown waits for image-info persistence before returning', async () => {
  const persisting = Promise.withResolvers(), release = Promise.withResolvers();
  let persisted = false, stopped = false;
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, metadataImages: { async close() {}, async updateImages(_context, _images, { persistImages }) { await persistImages(); return true; } } });
  const image = { Id: 'image', Path: '/image.png', Type: 'Primary', DateModified: stamp, Width: 1, Height: 1, Blurhash: Buffer.from('hash') };
  service.load = async () => ({ item: { Id: 'item', Path: '/movie.mkv' }, images: [image], imageAssets: { async stat() { return { size: 12n }; } } });
  service.persistImages = async () => { persisting.resolve(); await release.promise; persisted = true; };
  const info = service.info('item'); await persisting.promise;
  const stopping = service.close().then(() => { stopped = true; });
  try { await nextTurn(); assert.equal(stopped, false); assert.equal(persisted, false); }
  finally { release.resolve(); await stopping; }
  assert.equal(persisted, true); assert.equal((await info)[0].Size, 12n);
});

test('image shutdown cancels a same-item update waiting behind an active update', async () => {
  const entered = Promise.withResolvers();
  let updates = 0;
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, metadataImages: {
    async close() {},
    async updateImages(_context, _images, { signal }) {
      updates++; entered.resolve();
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    },
  } });
  const image = { Id: 'remote', Path: 'https://fixture/image.png', Type: 'Primary', DateModified: stamp };
  service.load = async () => ({ item: { Id: 'item', Path: '/movie.mkv' }, images: [structuredClone(image)] });
  const first = assert.rejects(service.info('item'), { name: 'AbortError' });
  await entered.promise;
  const second = assert.rejects(service.info('item'), { name: 'AbortError' });
  await nextTurn();
  await service.close();
  await Promise.all([first, second]);
  assert.equal(updates, 1);
});

for (const failure of [403, 404, 500]) test(`remote image HTTP ${failure} follows native removal and retry rules`, async () => {
  const calls = [], saves = [];
  const original = { Id: 'remote', Path: 'https://invalid.example/one.png|https://invalid.example/two.png', Type: 'Primary' };
  const retained = { Id: 'retained', Path: '/backdrop.png', Type: 'Backdrop' };
  const loaded = { item: { Id: 'fixture' }, images: [original, retained] };
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, metadataImages: { async close() {}, async saveRemote(_loaded, _images, image) { calls.push(image.Url); throw Object.assign(new Error('Synthetic HTTP failure'), { code: 'http-error', status: failure }); }, async updateImages() {} } });
  service.persist = async current => { saves.push(structuredClone(current.images)); };
  await assert.rejects(service.localize(loaded, original, 0));
  if (failure === 500) { assert.deepEqual(calls, ['https://invalid.example/one.png']); assert.deepEqual(loaded.images, [original, retained]); assert.deepEqual(saves, []); }
  else { assert.deepEqual(calls, ['https://invalid.example/one.png', 'https://invalid.example/two.png']); assert.deepEqual(loaded.images, [retained]); assert.deepEqual(saves, [[retained]]); }
  await service.close();
});

test('remote image fallback persists the successful replacement after a missing URL', async () => {
  const calls = []; let saved = false, updated = false;
  const controller = new AbortController(), blurhash = Buffer.from('Synthetic blurhash');
  const image = { Id: 'remote', Path: 'https://invalid.example/missing.png|https://invalid.example/found.png', Type: 'Primary' };
  const loaded = { item: { Id: 'fixture' }, images: [image] };
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, metadataImages: { async close() {}, async saveRemote(_loaded, images, requested, { index }) {
    calls.push(requested.Url); assert.equal(index, 0);
    if (calls.length === 1) throw Object.assign(new Error('Missing'), { code: 'http-error', status: 404 });
    images[0].Path = '/saved.png';
  }, async updateImages(context, images, { signal, forceUpdate }) {
    assert.deepEqual(context.item, loaded.item); assert.deepEqual(context.context.images, loaded.images); assert.deepEqual(images, loaded.images); assert.equal(signal, undefined); assert.equal(forceUpdate, true);
    assert.equal(images[0].Path, '/saved.png'); assert.equal(saved, false);
    Object.assign(images[0], { Width: 8, Height: 6, Blurhash: blurhash }); updated = true;
    return true;
  } } });
  service.persist = async current => {
    assert.equal(updated, true); assert.equal(current.images[0].Path, '/saved.png');
    assert.equal(current.images[0].Width, 8); assert.equal(current.images[0].Height, 6); assert.deepEqual(current.images[0].Blurhash, blurhash); saved = true;
  };
  assert.equal((await service.localize(loaded, image, 0, controller.signal)).Path, '/saved.png'); assert.equal(saved, true); assert.equal(calls.length, 2);
  await service.close();
});

test('remote image localization keeps unrelated item updates concurrent', async () => {
  let active = 0, peak = 0, release;
  const ready = Promise.withResolvers(), blocked = new Promise(resolve => { release = resolve; });
  const metadataImages = {
    async close() {},
    async saveRemote(loaded, images) {
      active++; peak = Math.max(peak, active); if (active === 2) ready.resolve();
      await blocked; images[0].Path = `/${loaded.item.Id}.png`; active--;
    },
    async updateImages() { return false; },
  };
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, metadataImages });
  service.persist = async () => {};
  const make = Id => { const image = { Id: `${Id}-image`, Path: `https://fixture/${Id}.png`, Type: 'Primary' }; return { loaded: { item: { Id }, images: [image] }, image }; };
  const first = make('first'), second = make('second');
  const tasks = [service.localize(first.loaded, first.image, 0), service.localize(second.loaded, second.image, 0)];
  let timeout;
  try { await Promise.race([ready.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Unrelated image updates were serialized.')), 1000); })]); }
  finally { clearTimeout(timeout); }
  release();
  const localized = await Promise.all(tasks);
  assert.equal(peak, 2); assert.deepEqual(localized.map(image => image.Path), ['/first.png', '/second.png']);
  await service.close();
});

test('closed image service rejects new profile lookups before touching persistence', async () => {
  let reads = 0;
  const service = new ImageService({fileSystem: testFileSystem,  processor: {}, store: { async run() { reads++; return []; } } });
  await service.close();
  await assert.rejects(async () => service.user({ userId: '11111111-1111-1111-1111-111111111111' }, { auth: {} }), { name: 'AbortError' });
  assert.equal(reads, 0);
});
