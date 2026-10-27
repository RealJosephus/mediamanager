import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataImages } from '../../src/metadata/images.js';

const response = () => new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const abortable = signal => new Promise((resolve, reject) => {
  signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const keys = value instanceof Error ? [...new Set([
    ...Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)),
    ...['message', 'code'].filter(key => key in value),
  ])] : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functional(value[key])]));
};
const cancelled = (operation, signal = AbortSignal.abort()) => operation.then(
  () => assert.fail('The cancelled image operation must reject.'),
  reason => assert.deepEqual(functional(reason), functional(signal.reason)));

test('download cache reuses live bytes, refreshes expired URLs and rejects work after close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const requests = [];
  const service = new MetadataImages({ fetch: async url => {
    requests.push(url); return new Response(Buffer.from([requests.length, 2, 3]), { headers: { 'content-type': 'image/png' } });
  } });
  t.after(() => service.close());
  const one = await service.download('https://fixture/one.png'), two = await service.download('https://fixture/two.png');
  assert.deepEqual(one.bytes, Buffer.from([1, 2, 3])); assert.deepEqual(two.bytes, Buffer.from([2, 2, 3]));
  t.mock.timers.tick(9999);
  assert.deepEqual((await service.download('https://fixture/one.png')).bytes, one.bytes);
  assert.deepEqual(requests, ['https://fixture/one.png', 'https://fixture/two.png']);
  t.mock.timers.tick(1);
  assert.deepEqual((await service.download('https://fixture/one.png')).bytes, Buffer.from([3, 2, 3]));
  assert.deepEqual((await service.download('https://fixture/two.png')).bytes, Buffer.from([4, 2, 3]));
  const completedRequests = [...requests];
  await service.close();
  await cancelled(service.download('https://fixture/one.png'));
  t.mock.timers.tick(10000);
  await cancelled(service.download('https://fixture/two.png'));
  assert.deepEqual(requests, completedRequests);
});

test('a canceled URL owner releases the lock and an independent waiter downloads successfully', { timeout: 3000 }, async t => {
  let requests = 0;
  const service = new MetadataImages({ fetch: async (_, { signal }) => ++requests === 1 ? abortable(signal) : response() });
  t.after(() => service.close());
  const controller = new AbortController();
  const owner = cancelled(service.download('https://fixture/poster.png', controller.signal), controller.signal);
  const waiter = service.download('https://fixture/poster.png');
  controller.abort(false); await owner;
  assert.deepEqual((await waiter).bytes, Buffer.from([1, 2, 3])); assert.equal(requests, 2);
});

test('canceling a queued waiter returns promptly without canceling the URL owner', { timeout: 3000 }, async t => {
  let release, requests = 0, ownerSignal;
  const service = new MetadataImages({ fetch: async (_, { signal }) => { requests++; ownerSignal = signal; return new Promise(resolve => { release = () => resolve(response()); }); } });
  t.after(() => service.close());
  const owner = service.download('https://fixture/poster.png'), controller = new AbortController();
  const waiter = cancelled(service.download('https://fixture/poster.png', controller.signal), controller.signal);
  controller.abort(0); await waiter; assert.equal(ownerSignal.aborted, false);
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
  const tasks = ['one', 'one', 'two'].map(key => cancelled(service.download(`https://fixture/${key}.png`)));
  await service.close(); await Promise.all(tasks);
  await cancelled(service.download('https://fixture/new.png'));
});
