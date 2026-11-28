import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';

test('the NFO provider detects a real sidecar over the one-minute threshold at filesystem precision', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-nfo-clock-'));
  const registry = new StorageRegistry();
  t.after(async () => {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  });
  registry.registerType('local', config => LocalAdapter.open(config));
  await registry.createInstance('disk', 'local', { root });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'disk', capabilities: {} });
  const provider = createNfoPlugin({ vfs });
  const seconds = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const samples = [];
  for (const [name, fraction] of [['exact', 0], ['inside', 0.0005], ['outside', 0.004]]) {
    const sidecar = path.join(root, name + '.nfo');
    await writeFile(sidecar, '<movie><title>Edited</title></movie>');
    await utimes(sidecar, seconds + 60 + fraction, seconds + 60 + fraction);
    const item = { Type: 'Video', Path: '/media/' + name + '.mkv', DateLastSaved: '2026-01-01 00:00:00.0000000' };
    const { modified } = await vfs.stat('/media/' + name + '.nfo');
    const observed = await provider.hasChanged(item);
    const expected = modified > '2026-01-01T00:01:00.0000000Z';
    samples.push({ name, modified, observed, expected });
  }
  t.diagnostic('AUDIT nfo-time ' + JSON.stringify(samples));
  assert.deepEqual(samples.map(s => s.expected), [false, true, true], 'physical timestamps retained the control and both edits');
  assert.deepEqual(samples.map(s => s.observed), samples.map(s => s.expected));
});
