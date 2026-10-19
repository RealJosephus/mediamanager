import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { hydrateNativeItemEntity, nativeItemDescriptor, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { EMPTY_ID, MIN_DATE } from '../../src/library/records.js';
import {
  buildResolvedEntity,
  itemRequiresJson,
  nativeTypes,
  projectNativeItem,
  projectParentRows,
  projectRelations,
  projectStored,
  setupResolverEntityFixture,
} from './native-resolver-entity-types-fixture.js';

const root = new URL('./fixtures/native-resolver-entity-types/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const rawInput = await readFile(new URL('input.json', root), 'utf8');
const rawNative = await readFile(new URL('native.json', root), 'utf8');
const input = parseLosslessJson(rawInput);
const native = parseLosslessJson(rawNative);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const assemblyProjection = assemblies => assemblies.map(({ name, sha256 }) => ({ name, sha256 }));
const resultFor = sample => native.results.find(result => result.name === sample.name);

test('native resolver entity type fixture is sealed, complete and honestly scoped', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(hash(await readFile(new URL(file.path, repository))), file.sha256, file.path);
  assert.equal(hash(rawInput), native.inputSha256);
  assert.equal(native.actualFrozenNativeResolverEntityTypes, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(assemblyProjection(native.assemblies), provenance.assemblies);
  assert.equal(native.exactTypeCount, 15);
  assert.equal(native.caseCount, 16);
  assert.equal(native.mappedColumnCount, 72);
  assert.equal(provenance.capture.sourceFilesSha256, '1a07ed681f1e15be81aa2c209ef666eccfd10eded63588a11e1066620ed77ea9');
  assert.equal(provenance.candidateVerified, true);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.deepEqual(new Set(native.results.map(result => result.nativeType)), new Set(Object.values(nativeTypes)));

  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) {
    assert.equal(result.mapper.columnCount, 72, `${result.name} mapper column count`);
    assert.equal(result.stored.columnCount, 72, `${result.name} stored column count`);
    assert.deepEqual(Object.keys(result.mapper.columns).sort(), columns, `${result.name} mapper columns`);
    assert.deepEqual(Object.keys(result.stored.columns).sort(), columns, `${result.name} stored columns`);
    assert.deepEqual(result.mapper.columns, result.stored.columns, `${result.name} mapper/save scalar agreement`);
    assert.equal(result.mapper.dataText, result.stored.dataText, `${result.name} mapper/save raw Data agreement`);
    assert.deepEqual(result.mapper.data, result.stored.data, `${result.name} mapper/save parsed Data agreement`);
    assert.equal(result.requiresJson, itemRequiresJson(result.type), `${result.name} Data policy`);
    assert.equal(result.stored.dataIsNull, !result.requiresJson, `${result.name} Data nullness`);
    if (result.stored.dataIsNull) {
      assert.equal(result.stored.dataText, null);
      assert.equal(result.stored.data, null);
    } else {
      // This is intentionally not a sorted/canonicalized comparison: the
      // frozen raw text seals native key order, N-format GUIDs and escaping.
      assert.equal(JSON.stringify(result.stored.data), result.stored.dataText, `${result.name} exact raw Data text`);
    }
    assert.deepEqual(Object.keys(result.relations).sort(),
      ['ancestors', 'images', 'links', 'lockedFields', 'maps', 'providers', 'trailerTypes', 'values'].sort());
  }
  const folder = resultFor({ name: 'folder-physical' });
  assert.deepEqual(
    [folder.constructor.dateLastMediaAdded, folder.constructor.linkedChildrenLoaded],
    [null, false],
  );
  assert.deepEqual(
    [folder.resolvedLive.dateLastMediaAdded, folder.resolvedLive.linkedChildrenLoaded],
    [null, false],
  );
  assert.deepEqual(
    [folder.lookup.dateLastMediaAdded, folder.lookup.linkedChildrenLoaded],
    [MIN_DATE, true],
  );
  assert.equal(resultFor({ name: 'music-artist-physical' }).lookup.musicArtist.IsFolder, true);
  assert.equal(resultFor({ name: 'music-artist-by-name' }).lookup.musicArtist.IsFolder, false);
});

test('native item factory rejects leaf, wrong-namespace and unknown discriminators', () => {
  for (const type of ['Movie', 'MediaBrowser.Controller.Entities.Movie', 'Example.Entities.Movie']) {
    assert.throws(() => nativeItemDescriptor(type), TypeError);
    assert.throws(() => newNativeItemEntity(type), TypeError);
  }
});

for (const [offset, sample] of input.entries()) test(`native entity constructor ${sample.name}`, () => {
  const expected = resultFor(sample);
  const descriptor = nativeItemDescriptor(expected.nativeType);
  assert.deepEqual({ nativeType: descriptor.nativeType, type: descriptor.type, requiresJson: descriptor.requiresJson },
    { nativeType: expected.nativeType, type: sample.type, requiresJson: expected.requiresJson });

  const item = newNativeItemEntity(expected.nativeType);
  const stateRoot = path.win32.join('D:\\native-resolver-entity-types', sample.name);
  assert.deepEqual(projectNativeItem(item, stateRoot), expected.constructor);

  const independent = newNativeItemEntity(expected.nativeType);
  item.Tags = [...item.Tags, 'mutable control'];
  item.ProviderIds.Mutable = 'control';
  item.ImageInfos = [...item.ImageInfos,
    { Path: 'mutable.jpg', Type: 'Primary', DateModified: '2026-01-01T00:00:00.0000000Z', Width: 1, Height: 1, BlurHash: null }];
  if (item.AdditionalParts) item.AdditionalParts = [...item.AdditionalParts, 'mutable.media'];
  if (item.Artists) item.Artists = [...item.Artists, 'mutable artist'];
  assert.deepEqual(projectNativeItem(independent, stateRoot), expected.constructor, 'constructor lists and maps must be fresh');

  const resolved = buildResolvedEntity(sample, offset + 1, stateRoot);
  assert.deepEqual(projectNativeItem(resolved, stateRoot), expected.resolvedLive);
});

test('MusicArtist folder state follows ParentId instead of a static constructor family', () => {
  const item = newNativeItemEntity(nativeTypes.MusicArtist);
  assert.equal(item.IsAccessedByName, true);
  assert.equal(item.IsFolder, false);
  item.ParentId = '94000000-0000-0000-0000-000000000001';
  assert.equal(item.IsAccessedByName, false);
  assert.equal(item.IsFolder, true);
  item.ParentId = EMPTY_ID;
  assert.equal(item.IsAccessedByName, true);
  assert.equal(item.IsFolder, false);
});

async function readTestLinks(handle) {
  if (handle === EMPTY_NATIVE_LINKS) return [];
  const links = [];
  for await (const page of handle.store.pages(handle)) links.push(...page);
  return links;
}

test('Folder distinguishes fresh, assigned-empty and cold-loaded state', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const fixture = await setupChildrenFixture(t);
  const folder = newNativeItemEntity(nativeTypes.Folder);
  const folderId = '94000000-0000-0000-0000-000000000090';
  let cold;
  try {
    assert.equal(folder.DateLastMediaAdded, null);
    assert.deepEqual(await readTestLinks(folder.LinkedChildren), []);
    assert.equal(folder.LinkedChildrenLoaded, false);

    folder.LinkedChildren = await fixture.linkedChildren.createFromPlan({ parentId: folderId, plan: {
      text: 'SELECT 1::bigint AS "Ordinal", NULL::bytea AS "ItemId", 0::integer AS "Type", NULL::bytea AS "Path", NULL::bytea AS "LibraryItemId" WHERE FALSE', values: [],
    } });
    assert.deepEqual(await readTestLinks(folder.LinkedChildren), []);
    assert.equal(folder.LinkedChildrenLoaded, true, 'assigning even an empty complete set marks links loaded');

    await fixture.seed({ target: 'folder', items: [{ key: 'folder', type: 'Folder', Id: folderId }] });
    cold = hydrateNativeItemEntity({
      NativeType: nativeTypes.Folder,
      Type: 'Folder',
      DateLastMediaAdded: null,
    }, { linkedChildren: await fixture.database.withConnection(session => fixture.linkedChildren.load(session, folderId)) });
    assert.equal(cold.DateLastMediaAdded, MIN_DATE);
    assert.deepEqual(await readTestLinks(cold.LinkedChildren), []);
    assert.equal(cold.LinkedChildrenLoaded, true);
  } finally {
    releaseNativeItemLinks(folder); releaseNativeItemLinks(cold);
    await fixture.linkedChildren.flushReleases();
  }
});

for (const dialect of ['postgres']) for (const [offset, sample] of input.entries()) test(
  `${dialect}: native resolver entity round trip ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const expected = resultFor(sample);
    const { fixture, root: stateRoot } = await setupResolverEntityFixture(t, dialect, sample);
    const item = buildResolvedEntity(sample, offset + 1, stateRoot);
    const resolvedLive = projectNativeItem(item, stateRoot);
    assert.deepEqual(resolvedLive, expected.resolvedLive, 'controlled live entity');

    const creator = new ItemCreationService(fixture);
    fixture.library.itemCreation = creator;
    await creator.saveItems([item]);
    const lookup = await creator.getItemById(item.Id);
    assert.ok(lookup, 'saved item must cold-hydrate through getItemById');

    const actual = {
      stored: await projectStored(fixture.database, item.Id, stateRoot),
      lookup: projectNativeItem(lookup, stateRoot),
      relations: await projectRelations(fixture.database, item.Id, stateRoot),
      parentRows: await projectParentRows(fixture.database),
    };
    const expectedRoundTrip = {
      stored: expected.stored,
      lookup: expected.lookup,
      relations: expected.relations,
      parentRows: expected.parentRows,
    };
    assert.deepEqual(actual.stored.columns, expectedRoundTrip.stored.columns, 'all 72 stored columns');
    assert.deepEqual(actual.stored.data, expectedRoundTrip.stored.data, 'complete parsed Data');
    assert.equal(actual.stored.dataText, expectedRoundTrip.stored.dataText, 'exact raw Data key order and escaping');
    assert.deepEqual(actual.relations, expectedRoundTrip.relations, 'complete native relation projection');
    assert.deepEqual(actual.lookup, expectedRoundTrip.lookup, 'cold hydrated typed entity');
    assert.deepEqual(actual, expectedRoundTrip);
  });
