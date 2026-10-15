import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataImages } from '../../src/metadata/images.js';

const response = () => new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const abortable = signal => new Promise((resolve, reject) => {
  signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('download cache releases expired entries without another lookup and close releases live entries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let requests = 0;
  const service = new MetadataImages({ fetch: async () => { requests++; return response(); } });
  t.after(() => service.close());
  await service.download('https://fixture/one.png'); await service.download('https://fixture/two.png');
  assert.equal(service.cacheEntryCount, 2);
  t.mock.timers.tick(9999); assert.equal(service.cacheEntryCount, 2);
  t.mock.timers.tick(1); assert.equal(service.cacheEntryCount, 0);
  await service.download('https://fixture/one.png'); assert.equal(requests, 3);
  await service.close(); assert.equal(service.cacheEntryCount, 0);
  await assert.rejects(service.download('https://fixture/one.png'), { name: 'AbortError' });
  t.mock.timers.tick(10000); assert.equal(service.cacheEntryCount, 0);
});

test('a canceled URL owner releases the lock and an independent waiter downloads successfully', { timeout: 3000 }, async t => {
  let requests = 0;
  const service = new MetadataImages({ fetch: async (_, { signal }) => ++requests === 1 ? abortable(signal) : response() });
  t.after(() => service.close());
  const controller = new AbortController();
  const owner = assert.rejects(service.download('https://fixture/poster.png', controller.signal), { name: 'AbortError' });
  const waiter = service.download('https://fixture/poster.png');
  controller.abort(); await owner;
  assert.deepEqual((await waiter).bytes, Buffer.from([1, 2, 3])); assert.equal(requests, 2);
});

test('canceling a queued waiter returns promptly without canceling the URL owner', { timeout: 3000 }, async t => {
  let release, requests = 0, ownerSignal;
  const service = new MetadataImages({ fetch: async (_, { signal }) => { requests++; ownerSignal = signal; return new Promise(resolve => { release = () => resolve(response()); }); } });
  t.after(() => service.close());
  const owner = service.download('https://fixture/poster.png'), controller = new AbortController();
  const waiter = assert.rejects(service.download('https://fixture/poster.png', controller.signal), { name: 'AbortError' });
  controller.abort(); await waiter; assert.equal(ownerSignal.aborted, false);
  release(); await owner; assert.equal(requests, 1);
});

test('queued callers retry independently after a failed download and share a successful cached response', async t => {
  let requests = 0;
  const service = new MetadataImages({ fetch: async () => ++requests === 1 ? new Response('', { status: 500 }) : response() });
  t.after(() => service.close());
  const failed = assert.rejects(service.download('https://fixture/poster.png'), error => error.status === 500);
  const second = service.download('https://fixture/poster.png'), third = service.download('https://fixture/poster.png');
  await failed; assert.deepEqual((await second).bytes, (await third).bytes); assert.equal(requests, 2);
});

test('closing image downloads cancels owners and independent waiters and rejects new work', { timeout: 3000 }, async () => {
  const service = new MetadataImages({ fetch: async (_, { signal }) => abortable(signal) });
  const tasks = ['one', 'one', 'two'].map(key => assert.rejects(service.download(`https://fixture/${key}.png`), { name: 'AbortError' }));
  await service.close(); await Promise.all(tasks);
  assert.equal(service.cacheEntryCount, 0); await assert.rejects(service.download('https://fixture/new.png'), { name: 'AbortError' });
});
