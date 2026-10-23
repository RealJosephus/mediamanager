import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { idKey } from '../../src/library/records.js';
import { cachedFolderChildren } from '../../src/library/collection-membership.js';
import { physicalCollectionFolders } from '../../src/library/collection-physical-folders.js';
import { setupChildrenFixture } from './children-fixture.js';

const root = new URL('./fixtures/internal-folder-physical-folders/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const aggregateId = '97d10000-0000-0000-0000-000000000099';
const typeName = type => type === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie' : 'MediaBrowser.Controller.Entities.' + type;
test('physical folder fixture seals actual root matching, repository fallback and cached-ID lookup', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(native.actualFrozenInternalPhysicalFolders, true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 25); assert.equal(native.results.length, 25);
  compare(native.results.map(value => value.exception), input.map(value => value.expectException ?? null));
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
});
test('physical parent projection detects newest-row, raw-path and duplicate-ID mistakes', () => {
  for (const name of ['fallback-newest', 'fallback-case', 'cached-ids-order']) {
    const expected = native.results.find(value => value.name === name), actual = structuredClone(expected);
    actual.result.ids = ['wrong']; assert.throws(() => compare(actual, expected), assert.AssertionError);
  }
});
for (const dialect of ['postgres']) for (const sample of input) {
  test(dialect + ': actual collection physical folder selection ' + sample.name,
    async t => {
      const fixture = await setupChildrenFixture(t, dialect);
      fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Views', accessRoot: '/fixture/physicalviews', style: 'windows', returnAccess: 'Isolated collection physical-folder control' });
      fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Media', accessRoot: '/fixture/physicalmedia', style: 'windows', returnAccess: 'Isolated collection own-path control' });
      const entity = definition => Object.fromEntries(Object.entries({ key: definition.id, type: definition.type, Id: definition.id, Name: definition.Name ?? definition.type,
        Path: definition.Path, DateCreated: definition.DateCreated, OwnerId: definition.OwnerId, ExtraType: definition.ExtraType === 'Trailer' ? 2 : definition.ExtraType,
        PhysicalLocationsList: definition.PhysicalLocationsList === undefined ? [] : definition.PhysicalLocationsList,
        PhysicalFolderIds: definition.PhysicalFolderIds === undefined ? [] : definition.PhysicalFolderIds }).filter(([, value]) => value !== undefined));
      const target = entity(sample.item), items = [target, ...sample.parents.map(entity), ...sample.collections.map(entity),
        { key: 'aggregate', type: 'AggregateFolder', Id: aggregateId, IsFolder: true, Name: 'Physical root', Path: null }];
      // Stage unrelated owners first without references, then install exact links.
      await fixture.seed({ target: target.key, items: items.map(item => ({ ...item, OwnerId: null })) });
      for (const item of items) {
        const rootIndex = sample.rootChildren.indexOf(item.Id);
        await fixture.database.update('BaseItems', { Id: item.Id }, { Type: typeName(item.type), IsFolder: item.type !== 'Movie',
          OwnerId: item.OwnerId ?? null, ParentId: rootIndex >= 0 ? aggregateId : null,
          SortName: rootIndex >= 0 ? String(rootIndex).padStart(3, '0') : item.Name });
      }
      // The native control materializes explicit null collections before calls.
      const loaded = await fixture.loadContext(target.Id), item = loaded.item;
      if (sample === input[0]) {
        const unknownId = '97d10000-0000-0000-0000-000000000098';
        const unknownPath = 'Z:\\Views\\removed-plugin';
        const [template] = await fixture.database.rows('BaseItems', { where: { Id: target.Id } });
        await fixture.database.insert('BaseItems', { ...template, Id: unknownId,
          Type: 'Removed.Plugin.UnknownItem', Path: unknownPath, IsFolder: true });
        assert.equal((await fixture.database.rows('BaseItems', { where: { Path: unknownPath } })).length, 1);
        assert.equal(await loaded.findMetadataItemByPath(unknownPath, true), null);
        await fixture.database.delete('BaseItems', { Id: unknownId });
        const queries = [];
        fixture.database.queryHook = async (...args) => {
          const result = await fixture.database.client.query(...args);
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
          if (text.includes('/* metadata-item-by-path */')) queries.push(text);
          return result;
        };
        await loaded.findMetadataItemByPath('   ', true);
        fixture.database.queryHook = null;
        assert.equal(queries.length, 1);
        assert.match(queries[0], /"OwnerId" IS NULL OR candidate\."ExtraType" IS NOT NULL/u);
        assert.match(queries[0], /"PrimaryVersionId" IS NULL OR NOT EXISTS/u);
        assert.match(queries[0], /ORDER BY candidate\."DateCreated" DESC NULLS LAST,[\s\S]*LIMIT 1/u);
      }
      await fixture.store.run(async session => {
        const state = await fixture.library.load(session, null, { baseRows: await session.rows('BaseItems') });
        try {
          if (sample.item.PhysicalLocationsList === null) item.PhysicalLocationsList = null;
          if (sample.item.PhysicalFolderIds === null) item.PhysicalFolderIds = null;
          const aggregate = state.byId.get(idKey(aggregateId));
          compare(cachedFolderChildren(aggregate, state).map(child => child.Id.toLowerCase()), sample.rootChildren);
          const findCalls = [], findByPath = async (path, isFolder) => {
            findCalls.push({ path, isFolder }); return loaded.findMetadataItemByPath(path, isFolder);
          };
          let exception = null, parameterName = null, result;
          const before = await session.rows('BaseItems');
          try {
            const selected = await physicalCollectionFolders(item, state, { session, enableCache: sample.enableCache, findByPath });
            result = { ids: selected.map(folder => folder.Id.toLowerCase()), names: selected.map(folder => folder.Name), findCalls };
          } catch (error) { exception = error.nativeException ?? error.name; parameterName = error.parameterName ?? null; result = { findCalls }; }
          const expected = native.results.find(value => value.name === sample.name);
          compare({ exception, parameterName, result }, { exception: expected.exception, parameterName: expected.parameterName, result: expected.result });
          compare(await session.rows('BaseItems'), before);
        } finally { await state.dispose({ session }); }
      });
      if (sample.name === 'root-direct') {
        // The retained metadata context outlives its load operation. This
        // consumer must borrow a current session instead of its old state.db.
        const selected = await loaded.physicalFolders(false), expected = native.results.find(value => value.name === sample.name).result;
        compare({ ids: selected.map(folder => folder.Id.toLowerCase()), names: selected.map(folder => folder.Name) },
          { ids: expected.ids, names: expected.names });
      }
    });
}
