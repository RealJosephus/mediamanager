import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalXmlProviders } from '../../src/metadata/local-xml-provider.js';
import { localXmlSavePath } from '../../src/metadata/local-xml.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];

test('Local XML providers retain actual read and close errors and release undelivered SQL members', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-xml-provider-ownership-'));
  const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined],
    ['error', new Error('Actual XML reader cleanup failed.')]];
  const scenarios = reasons.flatMap(([name, reason]) => [false, true].map(primary => ({ label: `${primary ? 'read-and-' : ''}close-${name}`, reason, primary, closeFails: true })))
    .concat([{ label: 'recoverable-read', primary: true, closeFails: false }]);
  for (const { label, reason, primary, closeFails } of scenarios) await t.test(label, async t => {
    const files = path.join(root, label); await fs.mkdir(files);
    const filename = path.join(files, 'collection.xml');
    const bytes = Buffer.from('<Item><LocalTitle>Partial owned XML</LocalTitle><CollectionItems><CollectionItem><Path>Z:\\Media\\one.mkv</Path></CollectionItem><CollectionItem><Path>Z:\\Media\\one.mkv</Path></CollectionItem></CollectionItems></Item>');
    await fs.writeFile(filename, bytes);
    const database = await createPostgresTestDatabase(t, 'xml_source_owner');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const registry = new StorageRegistry(); registry.registerType('local', config => LocalAdapter.open(config));
    const adapter = await registry.createInstance('files', 'local', { root: files, writable: true });
    const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    vfs.mount({ path: '/files', instanceId: 'files', capabilities: {} });
    identityMap.addPrefix({ identityRoot: files, accessRoot: '/files', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual read-only XML fixture.' });
    const fileSystem = new StorageFileSystem({ vfs, identityMap });
    let selected = true, result, sourceCloses = 0, bytesRead = 0;
    t.after(async () => {
      selected = false; if (result) releaseNativeItemLinks(result.Item);
      await links.flushReleases(); await fileSystem.close(); await registry.close(); await links.close();
      assert.equal(path.dirname(files), root); await fs.rm(files, { recursive: true });
    });
    const readFailure = Object.assign(new Error('The actual XML source failed after its stored bytes.'), { code: 'EIO' });
    const openRead = adapter.openRead.bind(adapter);
    adapter.openRead = async (...args) => {
      const source = await openRead(...args);
      return { ...source, stream: (async function* () {
        for await (const chunk of source.stream) { bytesRead += chunk.length; yield chunk; }
        if (selected && primary) throw readFailure;
      })(), async close() { await source.close(); sourceCloses++; if (selected && closeFails) throw reason; } };
    };
    const provider = createLocalXmlProviders({ fileSystem, linkedChildren: links, savePath: localXmlSavePath }).find(value => value.id === 'BoxSetXmlProvider');
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.BoxSet'); item.Path = files;
    const context = { localPath: files, localRoot: files };
    const failed = await provider.getMetadata(item, context).then(value => { result = value; return { value }; }, error => ({ error }));
    if (closeFails) {
      assert.ok(Object.hasOwn(failed, 'error'), 'An input cleanup failure prevents delivery of partial SQL members.');
      if (primary) { assert.equal(failed.error.cause, readFailure); assert.equal(failed.error.code, 'EIO'); assert.deepEqual(failed.error.errors, [readFailure, reason]); }
      else assert.equal(failed.error, reason);
    } else {
      assert.equal(Object.hasOwn(failed, 'error'), false); assert.equal(result.HasMetadata, false);
      assert.equal(result.Item.Name, 'Partial owned XML');
      assert.deepEqual((await links.page(result.Item.LinkedChildren)).map(row => row.Path), ['Z:\\Media\\one.mkv', 'Z:\\Media\\one.mkv']);
      releaseNativeItemLinks(result.Item); result = undefined; await links.flushReleases();
    }
    const counts = async () => {
      const counts = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      return counts;
    };
    const afterFailure = await counts(); assert.deepEqual(afterFailure, { sets: 0, rows: 0, pins: 0 });
    assert.equal(sourceCloses, 1); assert.equal(bytesRead, bytes.length); assert.deepEqual(await fs.readFile(filename), bytes);
    selected = false; result = await provider.getMetadata(item, context); assert.equal(result.HasMetadata, true);
    const recovered = await links.page(result.Item.LinkedChildren);
    assert.deepEqual(recovered.map(row => row.Path), ['Z:\\Media\\one.mkv', 'Z:\\Media\\one.mkv']);
    releaseNativeItemLinks(result.Item); result = undefined; await links.flushReleases();
    assert.deepEqual(await counts(), afterFailure); assert.equal(sourceCloses, 2);
    await fs.writeFile(path.join(root, label + '.json'), JSON.stringify({ label, failure: errorObservation(failed.error), sourceCloses,
      bytesRead, afterFailure, recoveredPaths: recovered.map(row => row.Path), sourceBytes: bytes.toString('base64') }, null, 2) + '\n');
  });
});
