import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { createStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { identityPathStyle } from '../../src/storage/uri.js';
import { fixtureIds, fixtureRow } from '../database/fixtures.js';
import { createInstanceFixture } from './instance-fixture.js';

test('an explicit media declaration can accompany a state package for either stored UNC spelling', async t => {
  const itemId = fixtureIds.BaseItems;
  const hash = createHash('sha256').update('x').digest('hex');
  for (const sep of ['\\', '/']) {
    const identityRoot = sep.repeat(2) + 'nas' + sep + 'Media';
    const identityPath = identityRoot + sep + 'Clip.mkv';
    assert.equal(identityPathStyle(identityPath), 'windows');
    const instance = await createInstanceFixture(t, { prefix: 'state-package-share-' });
    instance.database.insert('BaseItems', { ...fixtureRow(tableDefinition('BaseItems')), Id: itemId,
      Path: identityPath, ParentId: null, TopParentId: null, Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
      IsFolder: false, IsVirtualItem: false, IsInMixedFolder: false, MediaType: 'Video', Data: '{"VideoType":"VideoFile","IsShortcut":false}' });
    const mediaAccess = { scope: 'explicit-items', items: [{ itemId, identityPath, identityRoot,
      enumeration: { kind: 'native-filesystem', root: identityRoot }, read: { kind: 'native-local-media-proxy' },
      expected: { bytes: '1', sha256: hash, range: { start: '0', end: '0', sha256: hash } }, sidecars: [] }] };
    const destination = path.join(instance.directory, 'declared');
    const options = await instance.packageOptions({ destination, mediaAccess });
    const otherShare = structuredClone(mediaAccess);
    otherShare.items[0].identityRoot = otherShare.items[0].enumeration.root = '//nas/Other';
    await assert.rejects(createStatePackage({ ...options, mediaAccess: otherShare }), /outside its identity root/);
    await assert.rejects(stat(path.join(destination, 'COMMITTED')), { code: 'ENOENT' });
    await createStatePackage(options);
    assert.ok((await stat(path.join(destination, 'COMMITTED'))).isFile());
    assert.deepEqual((await verifyStatePackage(destination)).mediaAccess, mediaAccess);
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).mediaAccess, mediaAccess);
  }
});
