import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { supportsOwnedItems, searchesContainingFolderForExtras } from '../../src/library/owned-items.js';
import { mediaSourceCount } from '../../src/library/media-versions.js';
import { idKey, VIDEO_TYPES } from '../../src/library/records.js';

const root = new URL('./fixtures/owned-item-support/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(read));
test('owned support oracle seals actual virtual getter and linked-count evidence', async () => {
  for (const file of provenance.fixtureFiles) {
    const url = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedItemSupport, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles.find(file => file.path.endsWith('/input.json')).sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 49);
});

for (const sample of input) test(`native owned support: ${sample.name}`, () => {
  const expected = native.results.find(result => result.name === sample.name);
  const items = sample.items.map(item => ({ ...structuredClone(item), Type: item.type }));
  const byKey = new Map(items.map(item => [item.key, item]));
  const state = { items, byId: new Map(items.map(item => [idKey(item.Id), item])),
    links: sample.links.map((link, SortOrder) => ({ ParentId: byKey.get(link.parent).Id,
      ChildId: byKey.get(link.child).Id, ChildType: link.childType, SortOrder })) };
  const target = byKey.get('target');
  assert.deepEqual({ name: sample.name, supportsOwnedItems: supportsOwnedItems(target, state),
    searchesContainingFolderForExtras: searchesContainingFolderForExtras(target, state),
    mediaSourceCount: VIDEO_TYPES.has(target.Type) ? mediaSourceCount(target, state) : null }, expected);
});
