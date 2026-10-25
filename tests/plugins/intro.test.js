import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginFixture } from './fixture.js';

test('intro provider disable cancels and drains an admitted plugin call', async t => {
  const fixture = await pluginFixture(t);
  const source = path.join(fixture.root, 'intro-package'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@test/intro-cancel', version: '0.1.0', type: 'module',
    mediamanager: { id: 'intro-cancel', name: 'Controlled intro cancellation', entry: 'index.js' } }));
  await writeFile(path.join(source, 'index.js'), `import { writeFile } from 'node:fs/promises'; import path from 'node:path';
    export async function activate(context) {
      await context.register('intro', { async getIntros(item, { user, signal }) {
        if (user.Name !== 'Reader' || !signal) throw new Error('Missing intro context.');
        await writeFile(path.join(context.dataPath, 'started'), 'started');
        try { await new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }); } finally { await writeFile(path.join(context.dataPath, 'drained'), 'drained'); }
      }});
    }`);
  await fixture.host.install(source);
  const provider = fixture.host.entries('intro')[0];
  const pending = provider.getIntros({ Name: 'Feature' }, { user: { Name: 'Reader' } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const started = path.join(fixture.host.directory, 'data/intro-cancel/started');
  for (let attempt = 0; ; attempt++) {
    try { assert.equal(await readFile(started, 'utf8'), 'started'); break; }
    catch (error) { if (error.code !== 'ENOENT' || attempt === 1000) throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  await fixture.host.setEnabled('intro-cancel', false); await rejected;
  assert.deepEqual(fixture.host.entries('intro'), []);
  assert.equal(await readFile(path.join(fixture.host.directory, 'data/intro-cancel/drained'), 'utf8'), 'drained');
  assert.throws(() => provider.getIntros({}, {}), { status: 503 });
});
