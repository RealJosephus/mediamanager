import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { ChannelItemCache, channelDataCachePath } from '../../src/library/channel-item-cache.js';
import { channelItemProviderResult } from '../../src/library/channel-item-data.js';
import { testFileSystem } from '../storage/plugin-files.js';

async function remove(root) {
  const parent = path.resolve(os.tmpdir()), target = path.resolve(root), relative = path.relative(parent, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Channel cache cleanup escaped its owner.');
  await rm(target, { recursive: true, force: true });
}
async function within(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Channel cache owner did not drain.')), 30000); })]); }
  finally { clearTimeout(timer); }
}

test('Channel cache serializes admitted fetches, cancels a waiter and drains its exact file owner', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-cache-operation-')), entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  const cachePath = path.join(root, 'cache'), id = 'ce100000000000000000000000000003'; let cache, first, waiter, same, closing, calls = 0;
  try {
    await mkdir(cachePath);
    cache = new ChannelItemCache({ cachePath, fileSystem: testFileSystem, getChannelId: () => id });
    const provider = { name: 'Controlled', dataVersion: 'one', async getChannelItems(query) {
      calls++; assert.deepEqual(query, { UserId: '0'.repeat(32), FolderId: null, StartIndex: null, Limit: null, SortBy: null, SortDescending: false });
      entered.resolve(); await proceed.promise; return { Items: [] };
    } };
    first = cache.get(provider, null, null); void first.catch(() => {}); await within(entered.promise);
    const cancelled = new AbortController(); waiter = cache.get(provider, null, 'different', { signal: cancelled.signal });
    const reason = new Error('Cancel only this waiting consumer.'); const rejected = assert.rejects(waiter, error => error === reason);
    cancelled.abort(reason); await within(rejected);
    same = cache.get(provider, null, null); void same.catch(() => {});
    let closed = false; closing = cache.close().then(() => { closed = true; });
    await assert.rejects(cache.get(provider, null, null), { status: 503 }); assert.equal(closed, false); assert.equal(calls, 1);
    proceed.resolve(); assert.deepEqual((await within(first)).Items, []); assert.equal(await within(same), null);
    await within(closing); assert.equal(closed, true); assert.equal(calls, 1);
    const file = channelDataCachePath({ cachePath, channelId: id, dataVersion: 'one' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { Items: [] });
  } finally { proceed.resolve(); await Promise.allSettled([first, waiter, same, closing]); await cache?.close(); await remove(root); }
});

test('Channel provider binding preserves explicit null source collections until the native materializer consumes them', () => {
  assert.equal(channelItemProviderResult(null), null);
  assert.equal(channelItemProviderResult({ Items: null }).Items, null);
  const result = channelItemProviderResult({ Items: [{ Id: 'explicit', MediaSources: null }, { Id: 'default' }, { Id: 'member', MediaSources: [null] }] });
  assert.equal(result.Items[0].MediaSources, null); assert.deepEqual(result.Items[1].MediaSources, []); assert.deepEqual(result.Items[2].MediaSources, [null]);
});
