import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginFixture } from './fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

test('intro provider disable cancels and drains an admitted plugin call', async t => {
  const fixture = await pluginFixture(t);
  const source = path.join(fixture.root, 'intro-package'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@test/intro-cancel', version: '0.1.0', type: 'module',
    mediamanager: { id: 'intro-cancel', name: 'Controlled intro cancellation', entry: 'index.js' } }));
  await writeFile(path.join(source, 'index.js'), `import { rename, writeFile } from 'node:fs/promises'; import path from 'node:path';
    export async function activate(context) {
      await context.register('intro', { async getIntros(item, { user, signal }) {
        if (user.Name !== 'Reader' || !signal) throw new Error('Missing intro context.');
        const started = path.join(context.dataPath, 'started');
        // Publish admission after the marker contents have been written.
        await writeFile(started + '.pending', 'started');
        await rename(started + '.pending', started);
        try { await new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }); } finally { await writeFile(path.join(context.dataPath, 'drained'), 'drained'); }
      }});
    }`);
  await fixture.host.install(source);
  const provider = fixture.host.entries('intro')[0];
  const pending = provider.getIntros({ Name: 'Feature' }, { user: { Name: 'Reader' } });
  let cancellation;
  const rejected = assert.rejects(pending, error => {
    cancellation = error.name;
    return cancellation === 'AbortError';
  });
  const started = path.join(fixture.host.directory, 'data/intro-cancel/started');
  let admitted;
  for (let attempt = 0; ; attempt++) {
    try { admitted = await readFile(started, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT' || attempt === 1000) throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.equal(admitted, 'started');
  await assert.rejects(readFile(started + '.pending'), { code: 'ENOENT' });
  await fixture.host.setEnabled('intro-cancel', false); await rejected;
  const providers = fixture.host.entries('intro');
  assert.deepEqual(providers, []);
  const drained = await readFile(path.join(fixture.host.directory, 'data/intro-cancel/drained'), 'utf8');
  assert.equal(drained, 'drained');
  let unavailableStatus;
  assert.throws(() => provider.getIntros({}, {}), error => {
    unavailableStatus = error.status;
    return unavailableStatus === 503;
  });
  const output = path.resolve(validationOutputRoot());
  await mkdir(output, { recursive: true });
  const evidence = await mkdtemp(path.join(output, 'intro-drain-'));
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({
    admitted, drained, cancellation, unavailableStatus, remainingProviders: providers.length,
  }) + '\n');
});
