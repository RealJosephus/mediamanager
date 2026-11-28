import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('NFO providers compare the same physical sidecars one tick before, at and after one minute', async t => {
  const root = await mkdtemp(path.join(validationOutputRoot(), 'nfo-file-clock-'));
  const result = path.join(root, 'native.json');
  const project = fileURLToPath(new URL('./fixtures/nfo-file-clock/Oracle.csproj', import.meta.url));
  await recordOracle({ project, output: path.join(root, 'oracle'), args: [root, result] });
  const observations = JSON.parse(await readFile(result, 'utf8'));
  assert.deepEqual(observations.map(row => row.changed), [false, false, true]);

  const registry = new StorageRegistry();
  t.after(() => registry.close());
  registry.registerType('local', config => LocalAdapter.open(config));
  await registry.createInstance('disk', 'local', { root });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'disk', capabilities: {} });
  const provider = createNfoPlugin({ vfs });
  for (const row of observations) {
    const base = '/media/' + row.name;
    assert.equal((await vfs.stat(base + '.nfo')).modified, row.modified);
    const item = { Type: 'Movie', Path: base + '.mkv', IsInMixedFolder: true, DateLastSaved: row.saved };
    assert.equal(await provider.hasChanged(item), row.changed, row.name);
  }
  t.diagnostic(JSON.stringify(observations));
});
