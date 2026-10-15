import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixturePackage, pluginFixture } from './fixture.js';
import { MetadataImages } from '../../src/metadata/images.js';

const module = `
import fs from 'node:fs/promises';
import path from 'node:path';
export async function activate(context) {
  const record = value => fs.appendFile(path.join(context.dataPath,'events.txt'),value+'\\n');
  context.own(() => record('closed'));
  await context.register('metadata',{id:context.id,name:'Dynamic image plugin',providers:[{
    id:'cover',name:'Dynamic image plugin',kind:'image',imageSource:'dynamic',itemTypes:['Book'],imageTypes:['Primary'],
    async getImage(item,{type,signal}) {
      if(type !== 'Primary' || !signal) throw new Error('The dynamic operation options are missing.');
      await record('started');
      try {
        if(item.wait) await new Promise((resolve,reject) => {
          if(signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
        });
        return {bytes:Buffer.from('owned cover'),mimeType:'image/png'};
      } finally { await record('finished'); }
    }
  }]});
}
`;

test('dynamic getImage joins plugin request cancellation, disable drain and future admission checks', async t => {
  const fixture = await pluginFixture(t), directory = await fixturePackage(fixture.root);
  await writeFile(path.join(directory, 'index.js'), module);
  await fixture.host.install(directory);
  const provider = fixture.host.entries('metadata')[0].providers[0];
  const owned = await provider.getImage({}, { type: 'Primary' });
  const request = new AbortController(), requestWork = provider.getImage({ wait: true }, { type: 'Primary', signal: request.signal });
  const requestRejection = assert.rejects(requestWork, { name: 'AbortError' });
  request.abort(); await requestRejection;
  const work = provider.getImage({ wait: true }, { type: 'Primary' }), rejected = assert.rejects(work, { name: 'AbortError' });
  await fixture.host.setEnabled('fixture', false); await rejected;
  assert.deepEqual(fixture.host.entries('metadata'), []);
  assert.throws(() => provider.getImage({}, { type: 'Primary' }), { status: 503 });
  assert.equal(owned.bytes.toString(), 'owned cover', 'returned byte ownership survives plugin disable');
  const events = (await readFile(path.join(fixture.host.directory, 'data', 'fixture', 'events.txt'), 'utf8')).trim().split('\n');
  assert.equal(events.filter(value => value === 'started').length, 3);
  assert.equal(events.filter(value => value === 'finished').length, 3);
  assert.equal(events.filter(value => value === 'closed').length, 1);
});

test('MetadataImages close aborts and drains an active dynamic operation before rejecting new work', async () => {
  const started = Promise.withResolvers(), cleanup = Promise.withResolvers(), service = new MetadataImages();
  const provider = { imageSource: 'dynamic', name: 'Owned resource', imageTypes: ['Primary'], async getImage(_item, { signal }) {
    started.resolve();
    try { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
    finally { await cleanup.promise; }
  } };
  const work = service.refreshProviders({ item: { Type: 'Book' } }, [], [provider]), rejected = assert.rejects(work, { name: 'AbortError' });
  await started.promise;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  cleanup.resolve(); await rejected; await closing;
  assert.throws(() => service.refreshProviders({ item: { Type: 'Book' } }, [], [provider]), { name: 'AbortError' });
});
