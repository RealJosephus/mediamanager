import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginFixture } from './fixture.js';
import { validateLiveTvExtension } from '../../src/plugins/live-tv-contract.js';

test('channel marker declarations and optional methods cross the actual SDK host with owned cancellation', { timeout: 30000 }, async t => {
  const calls = [], entered = Promise.withResolvers(), completed = Promise.withResolvers();
  const fixture = await pluginFixture(t, { options: { 'channel-markers': { invoke: async (method, args) => {
    calls.push({ method, args });
    if (method === 'getLatestMedia' && args[0].held) {
      entered.resolve(); const signal = args[1].signal;
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      completed.resolve(); signal.throwIfAborted();
    }
    return method === 'canDelete' ? true : method === 'getLatestMedia' ? [] : undefined;
  } } } });
  const source = path.join(fixture.root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@fixture/channel-markers', version: '0.1.0', type: 'module',
    mediamanager: { id: 'channel-markers', name: 'Channel markers', entry: 'index.js' } }));
  await writeFile(path.join(source, 'index.js'), `export async function activate(context){await context.register('channel',{
    type:'markers',name:'Markers',attributes:['rEcOrDiNgS'],disableMediaSourceDisplay:true,
    getChannelFeatures:()=>({}),isEnabledFor:()=>true,getChannelItems:()=>({Items:[]}),getChannelImage:()=>null,getSupportedChannelImages:()=>[],
    getLatestMedia:(...args)=>context.options.invoke('getLatestMedia',args),
    canDelete:(...args)=>context.options.invoke('canDelete',args),deleteItem:(...args)=>context.options.invoke('deleteItem',args)});}`);
  await fixture.host.install(source);
  const extension = fixture.host.entries('channel')[0], caller = new AbortController();
  assert.deepEqual(extension.attributes, ['rEcOrDiNgS']); assert.equal(extension.disableMediaSourceDisplay, true);
  assert.deepEqual(await extension.getLatestMedia({ userId: 'original' }, { signal: caller.signal }), []);
  assert.equal(await extension.canDelete({ ExternalId: 'native' }, { signal: caller.signal }), true);
  await extension.deleteItem('native', { signal: caller.signal });
  assert.deepEqual(calls.map(value => value.method), ['getLatestMedia', 'canDelete', 'deleteItem']);
  assert.ok(calls.every(value => value.args[1].signal instanceof AbortSignal && value.args[1].signal !== caller.signal));
  const pending = extension.getLatestMedia({ held: true }); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; const closing = fixture.host.close(); await completed.promise; await rejected; await closing;
  assert.equal(fixture.host.entries('channel').length, 0);
  assert.throws(() => extension.canDelete({}), { status: 503 });
});

test('channel deletion pairs and synchronous marker metadata are validated before registration', () => {
  const baseline = { type: 'baseline', name: 'Baseline', getChannelFeatures() {}, isEnabledFor() {}, getChannelItems() {}, getChannelImage() {}, getSupportedChannelImages() {} };
  for (const extra of [{ canDelete() {} }, { deleteItem() {} }, { attributes: null }, { attributes: [3] }, { disableMediaSourceDisplay: 'true' }]) {
    assert.throws(() => validateLiveTvExtension('channel', { ...baseline, ...extra }), TypeError);
  }
  assert.doesNotThrow(() => validateLiveTvExtension('channel', { ...baseline, disableMediaSourceDisplay: false, attributes: [], canDelete() {}, deleteItem() {} }));
});
