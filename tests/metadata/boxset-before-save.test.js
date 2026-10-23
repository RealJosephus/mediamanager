import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeSaveBoxSetMetadata } from '../../src/metadata/boxset-before-save.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { idKey, loadLibrary } from '../../src/library/records.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { metadataFields } from '../../src/library/metadata-context.js';
import { setupChildrenFixture } from './children-fixture.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const root = new URL('./fixtures/boxset-before-save/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expectedFor = scenario => native.results.find(entry => entry.name === scenario.name);
const capture = item => ({ LibraryFolderIds: item.LibraryFolderIds == null ? null : item.LibraryFolderIds.map(idKey),
  PresentationUniqueKey: item.PresentationUniqueKey });
// The recording's CLR exception class is diagnostic. Preserve the actual
// collection query failure and the assertions that no save has committed.
const nullPhysicalLocationsFailure = { status: 500, message: "Value cannot be null. (Parameter 'source')" };

test('boxset affiliation recording binds actual native traversal, service and mapper', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, name] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(name, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 51); assert.equal(native.results.length, input.length);
  assert.equal(new Set(native.results.map(entry => entry.name)).size, input.length);
  assert.deepEqual(native.results.filter(entry => entry.exception).map(entry => entry.exception), ['ArgumentNullException', 'ArgumentNullException']);
});

async function controlledState(t,scenario) {
 const fixture=await setupChildrenFixture(t), Id=await fixture.seed(scenario), item=await fixture.library.itemCreation.getItemById(Id), source=createMetadataChildren(fixture);
 const loaded={item,boxSetLibraryFolderIds:value=>source.libraryFolderIds(value)};
 for(const definition of scenario.items) if(definition.missingLinks?.length) {
   assert.equal(scenario.pureOnly,true);
   const value=await fixture.library.itemCreation.getItemById(definition.Id), writer=await fixture.linkedChildren.withSession(session=>fixture.linkedChildren.createWriter({session,parentId:value.Id}));
   try {
     for(const child of definition.links??[]) await writer.append({ItemId:scenario.items.find(item=>item.key===child).Id,Type:0});
     for(const ItemId of definition.missingLinks) await writer.append({ItemId,Type:0});
     value.LinkedChildren=await writer.finish();
     if(idKey(value.Id)===idKey(Id)) loaded.item.LinkedChildren=value.LinkedChildren;
   } catch(error) {await writer.abort();throw error;}
 }
 return {fixture,loaded,item:loaded.item};
}

for (const scenario of input.filter(entry => entry.mode === 'before')) test(`native boxset BeforeSave: ${scenario.name}`, async t => {
 const {loaded,item}=await controlledState(t,scenario), expected=expectedFor(scenario);
 if(expected.exception) return assert.rejects(beforeSaveBoxSetMetadata(item,loaded),nullPhysicalLocationsFailure);
 assert.equal(await beforeSaveBoxSetMetadata(item,loaded)|ItemUpdateType.None,expected.updateType);
 assert.deepEqual(capture(item),capture(expected.item));
 assert.equal(await beforeSaveBoxSetMetadata(item,loaded),ItemUpdateType.None);
});

test('boxset comparison rejects reordered or stale affiliation projections',async t=>{
 const scenario=input.find(entry=>entry.name==='link order controls affiliation order'),{loaded,item}=await controlledState(t,scenario);
 const result=await loaded.boxSetLibraryFolderIds(item),expected=expectedFor(scenario).item.LibraryFolderIds;
 assert.deepEqual(result,expected);
 assert.throws(()=>assert.deepEqual(result.toReversed(),expected),assert.AssertionError);
 assert.throws(()=>assert.deepEqual([result[0]],expected),assert.AssertionError);
});

for (const dialect of ['postgres']) test(`${dialect}: BoxSet None refresh persists native affiliation, reasons and failure state`, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  for (const scenario of input.filter(entry => entry.mode === 'refresh')) await t.test(scenario.name, async () => {
    const Id = await fixture.seed(scenario), before = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    const links = await fixture.database.rows('LinkedChildren'), calls = [], expected = expectedFor(scenario);
    const report = ({ Item, UpdateReason }) => calls.push({ item: capture(Item), updateReason: UpdateReason });
    fixture.host.updates.on('ItemUpdated', report);
    let result;
    try {
      const pending = fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
      if (expected.exception) await assert.rejects(pending, nullPhysicalLocationsFailure);
      else result = await pending;
    } finally { fixture.host.updates.off('ItemUpdated', report); }
    const saved = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    if (expected.exception) assert.deepEqual(saved, before);
    else {
      assert.equal(result.UpdateType, expected.updateType);
      assert.deepEqual(capture((await fixture.loadContext(Id)).item), capture(expected.item));
      if (expected.calls.length) assert.deepEqual(JSON.parse(saved.Data).LibraryFolderIds, expected.mapped.LibraryFolderIds);
      else assert.deepEqual(saved, before);
    }
    assert.deepEqual(calls, expected.calls.map(call => ({ ...call, item: capture(call.item) })));
    let expectedLinks = links;
    if (!expected.exception && expected.calls.length) {
      // ItemPersistenceService groups non-Playlist links by ChildId, keeps the
      // last row in each first-seen group, and rewrites contiguous SortOrder.
      // The full-27 SaveItems capture verifies that SQL boundary; this older
      // BoxSet oracle intentionally recorded only its update callback.
      const grouped = new Map(), order = [];
      for (const link of links.filter(link => idKey(link.ParentId) === idKey(Id))) {
        const key = idKey(link.ChildId);
        if (!grouped.has(key)) order.push(key);
        grouped.set(key, link);
      }
      const target = order.map((key, SortOrder) => ({ ...grouped.get(key), SortOrder }));
      expectedLinks = [...links.filter(link => idKey(link.ParentId) !== idKey(Id)), ...target]
        .sort((left, right) => idKey(left.ParentId).localeCompare(idKey(right.ParentId)) || left.SortOrder - right.SortOrder);
    }
    assert.deepEqual(await fixture.database.rows('LinkedChildren'), expectedLinks);
  });
});
