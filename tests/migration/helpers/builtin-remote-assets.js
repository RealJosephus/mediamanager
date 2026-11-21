import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { captureRemoteAssets, inspectRemoteAssets } from '../../../src/migration/remote-assets.js';
import { createStatePackage, restoreRemoteStatePackage, verifyStatePackage } from '../../../src/migration/state-package.js';
import { createInstanceFixture } from '../instance-fixture.js';

export async function builtinRemoteAssetContract(t, vfs, strongVersion) {
  const instance = await createInstanceFixture(t);
  const destination = path.join(instance.directory, 'package');
  const source = '/network/package-source.nfo', target = '/network/package-restored.nfo';
  const assets = [{ assetId: 'movie', virtualPath: source, kind: 'nfo', restorePath: 'movie.nfo' }];
  const payload = Buffer.from('<movie><title>中文</title></movie>');
  const changed = Buffer.from('<movie><title>変更</title></movie>');
  assert.equal(changed.length, payload.length);
  await vfs.write(source, payload, { overwrite: false });
  const plan = await inspectRemoteAssets({ vfs, assets });
  if (strongVersion) assert.match(plan.assets[0].version, /^"/u);
  else assert.equal(plan.assets[0].version, null);

  const stale = path.join(instance.directory, 'stale');
  await mkdir(path.join(stale, 'files'), { recursive: true });
  await vfs.write(source, changed);
  await assert.rejects(captureRemoteAssets({ plan, destination: stale }), /Remote state changed during generation capture/u);
  await assert.rejects(access(path.join(stale, 'files', 'remote-assets/movie.nfo')), { code: 'ENOENT' });

  const manifest = await createStatePackage(await instance.packageOptions({ destination, remoteState: { vfs, assets } }));
  assert.deepEqual(await verifyStatePackage(destination), manifest);
  assert.deepEqual(await readFile(path.join(destination, 'files', manifest.remoteAssets[0].path)), changed);

  const restore = () => restoreRemoteStatePackage(destination, { vfs, targets: { movie: target } });
  assert.equal((await restore()).completed[0].reused, false);
  assert.equal((await restore()).completed[0].reused, true);
  const readTarget = async () => {
    const handle = await vfs.openRead(target);
    try { return await buffer(handle.stream); } finally { await handle.close(); }
  };
  assert.deepEqual(await readTarget(), changed);
  await vfs.write(target, payload);
  await assert.rejects(restore(), /refuses to overwrite different target content/u);
  assert.deepEqual(await readTarget(), payload);
}
