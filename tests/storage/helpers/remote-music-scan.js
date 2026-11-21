import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DotIgnoreRule } from '../../../src/library/dot-ignore-rule.js';
import { DirectoryItemResolverPipeline } from '../../../src/library/directory-item-resolver.js';
import { audioNativeType, createAudioItemResolver } from '../../../src/library/audio-item-resolver.js';
import { createFolderValidationScanFixture } from '../../helpers/folder-validation-scan-fixture.js';
import { createResolvedItemLifecycleFixture } from '../../library/resolved-item-lifecycle-fixture.js';
import { setupChildrenFixture } from '../../metadata/children-fixture.js';

export async function verifyRemoteMusicScan(t, source) {
  const directory = '/network/music-' + randomUUID();
  await source.mkdir(directory);
  t.after(() => source.delete(directory, { recursive: true }));
  await source.mkdir(directory + '/Unclassified');
  await source.write(directory + '/Track.mp3', Buffer.from('isolated MP3 filename and stat fixture'), { overwrite: false });
  const listing = await source.list(directory);
  assert.equal(listing.complete, true);
  assert.equal(listing.consistency, 'weak');
  assert.equal(listing.deletionSafe, false);
  assert.ok(listing.entries.some(entry => entry.name === 'Track.mp3' && entry.kind === 'file'));

  const f = await setupChildrenFixture(t);
  const remote = source.resolve(directory), stats = [];
  // Use the actual adapter with the same live transport and let its original
  // registry retain ownership for the rest of the remote-storage tests.
  f.storage.registerType('remote-music', () => new Proxy(remote.adapter, { get(adapter, key) {
    if (key === 'close') return () => {};
    if (key === 'stat') return (location, options) => { stats.push(location); return adapter.stat(location, options); };
    const property = Reflect.get(adapter, key, adapter);
    return typeof property === 'function' ? property.bind(adapter) : property;
  } }));
  await f.storage.createInstance('remote-music', 'remote-music', {});
  f.vfs.mount({ path: '/remote-music', instanceId: 'remote-music', root: remote.path, capabilities: {} });
  const identity = 'Z:\\RemoteMusic', rootId = randomUUID(), missingId = randomUUID();
  f.identityMap.addPrefix({ identityRoot: identity, accessRoot: '/remote-music', style: 'windows', caseSensitive: false,
    returnAccess: 'An isolated remote music scan fixture.' });
  await f.seed({ target: 'music', items: [
    { key: 'aggregate', type: 'AggregateFolder', Id: randomUUID() },
    { key: 'music', type: 'Folder', Id: rootId, Path: identity, TopParentId: rootId, parent: 'aggregate' },
    { key: 'missing', type: 'Audio', Id: missingId, Path: identity + '\\Missing.mp3', parent: 'music' },
  ] });
  const ignoreRule = new DotIgnoreRule({ vfs: f.vfs, identityMap: f.identityMap });
  const lifecycleFixture = await createResolvedItemLifecycleFixture({ ...f, ignoreRule });
  const resolverPipeline = new DirectoryItemResolverPipeline({
    programDataPath: f.stateRoot, resolvers: [createAudioItemResolver()],
  });
  const errors = [];
  const scan = createFolderValidationScanFixture({ ...f, itemCreation: f.library.itemCreation,
    programDataPath: f.stateRoot, resolverPipeline, ignoreRule, lifecycleFixture, onError: error => errors.push(error) });
  try {
    const validate = () => scan.itemCreation.withItem(rootId, parent => scan.validation.validateChildren(parent, {
      collectionType: 'music', refreshChildMetadata: false,
    }));
    const first = await validate();
    assert.deepEqual(first.created.map(item => item.Path), [identity + '\\Track.mp3']);
    assert.deepEqual((await validate()).created, []);
    const children = await f.database.rows('BaseItems', { where: { ParentId: rootId } });
    assert.equal(children.length, 2);
    assert.equal(children.find(item => item.Id === first.created[0].Id).Type, audioNativeType);
    assert.ok(children.some(item => item.Id === missingId));
    assert.ok(stats.includes(remote.path + '/Track.mp3'));
    assert.deepEqual(errors, []);
  } finally { try { await scan.close(); } finally { await lifecycleFixture.close(); } }
}
