import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeItemDescriptor, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { nativeItemJsonContract } from '../../src/library/native-item-data.js';
import { assertProjectedEqual } from '../comparison-observations.js';
import {
  normalizeRelationshipIds,
  runCoreCase,
  runSaveLifecycle,
} from './native-item-full27-typed-fixture.js';

const fixtureRoot = new URL('./fixtures/native-item-full27-typed/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const rawInput = await readFile(new URL('input.json', fixtureRoot), 'utf8');
const rawNative = await readFile(new URL('native.json', fixtureRoot), 'utf8');
const input = parseLosslessJson(rawInput);
const native = parseLosslessJson(rawNative);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const byName = new Map(native.results.map(result => [result.name, result]));
const resultFor = name => {
  const result = byName.get(name);
  assert.ok(result, `missing native result ${name}`);
  return result;
};
const assemblyProjection = assemblies => assemblies.map(({ name, sha256 }) => ({ name, sha256 }));
const columns = tableDefinition('BaseItems').columns.map(column => column.name);
const jsonTextOutcome = value => {
  if (value == null) return value;
  const { parseErrorType, parseErrorMessage, ...retained } = value;
  return { ...retained, parseFailed: parseErrorType != null };
};
const typedJsonOutcome = value => {
  const { errorType, errorMessage, ...retained } = value;
  return { ...retained, failed: errorType != null };
};
const sqlProjection = value => ({ ...value, data: jsonTextOutcome(value.data),
  columns: { ...value.columns, Data: jsonTextOutcome(value.columns.Data) } });
const constructorProjection = value => ({ ...value, typedJson: typedJsonOutcome(value.typedJson),
  mutableIsolation: Object.fromEntries(Object.entries(value.mutableIsolation).map(([name, fact]) => {
    const { sameReference, errorType, errorMessage, ...retained } = fact;
    return [name, { ...retained, failed: errorType != null }];
  })) });
const coreProjection = value => {
  const { logs, ...retained } = value;
  return { ...retained, constructor: constructorProjection(value.constructor),
    poison: { ...value.poison, typedJson: value.requiresJson ? typedJsonOutcome(value.poison.typedJson)
      : jsonTextOutcome(value.poison.typedJson) },
    databaseOverlay: sqlProjection(value.databaseOverlay),
    hydrated: { ...value.hydrated, typedJson: typedJsonOutcome(value.hydrated.typedJson) } };
};
const saveProjection = value => ({ ...value, stages: Object.fromEntries(Object.entries(value.stages)
  .map(([name, stage]) => {
    const { logs, ...retained } = stage;
    return [name, { ...retained, liveTypedJson: typedJsonOutcome(stage.liveTypedJson),
      mapper: sqlProjection(stage.mapper), stored: sqlProjection(stage.stored) }];
  })) });

test('full27 typed fixture is byte-sealed, complete and honestly scoped', async () => {
  for (const file of provenance.fixtureFiles) {
    assert.equal(hash(await readFile(new URL(file.path, repository))), file.sha256, file.path);
  }
  assert.equal(hash(rawInput), native.inputSha256);
  assert.equal(hash(rawNative), provenance.identity.nativeSha256);
  assert.equal(native.actualFrozenFull27TypedCore, true);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(assemblyProjection(native.assemblies), provenance.assemblies);
  assert.deepEqual({ exactTypes: native.exactTypeCount, core: native.coreCaseCount, malformed: native.malformedCaseCount,
    sourceMalformed: native.sourceOnlyMalformedCaseCount, boundaries: native.boundaryCaseCount,
    saveItems: native.saveItemsCaseCount, all: native.caseCount, columns: native.mappedColumnCount },
  { exactTypes: 27, core: 27, malformed: 15, sourceMalformed: 12, boundaries: 10, saveItems: 27, all: 91, columns: 72 });
  assert.equal(native.jsonPropertyManifestSha256, provenance.identity.jsonPropertyManifestSha256);
  assert.deepEqual(native.results.map(result => result.name), [
    ...input.coreTypes.map(value => `core-${value.name}`),
    ...input.malformedTypes.map(fullName => `malformed-${input.coreTypes.find(value => value.fullName === fullName).name}`),
    ...input.sourceOnlyMalformedTypes.map(fullName => `source-malformed-${input.coreTypes.find(value => value.fullName === fullName).name}`),
    ...input.boundaryCases.map(value => `${value.name}-${input.coreTypes.find(type => type.fullName === value.fullName).name}`),
    ...input.saveItemsTypes.map(fullName => `saveitems-${input.coreTypes.find(value => value.fullName === fullName).name}`),
  ]);

  for (const result of native.results.slice(0, 64)) {
    assert.deepEqual(Object.keys(result), ['name', 'kind', 'shortName', 'fullName', 'requiresJson', 'constructor',
      'poison', 'databaseOverlay', 'hydrated', 'logs'], result.name);
    assert.equal(result.databaseOverlay.columnCount, 72, result.name);
    assert.deepEqual(Object.keys(result.databaseOverlay.columns), columns, result.name);
    assert.deepEqual(Object.keys(result.databaseOverlay.relations),
      ['providers', 'lockedFields', 'trailerTypes', 'images', 'links', 'userData', 'ancestors', 'values', 'maps'], result.name);
  }
  for (const result of native.results.slice(64)) {
    assert.deepEqual(Object.keys(result), ['name', 'kind', 'shortName', 'fullName', 'requiresJson', 'stages'], result.name);
    for (const [stageName, stage] of Object.entries(result.stages)) {
      assert.deepEqual(Object.keys(stage), ['stage', 'live', 'liveTypedJson', 'mapper', 'stored', 'logs'], `${result.name}/${stageName}`);
      assert.equal(stage.stage, stageName);
      for (const projection of [stage.mapper, stage.stored]) {
        assert.equal(projection.columnCount, 72, `${result.name}/${stageName}`);
        assert.deepEqual(Object.keys(projection.columns), columns, `${result.name}/${stageName}`);
        if (result.requiresJson) assert.deepEqual(projection.columns.Data, projection.data, `${result.name}/${stageName} Data projection`);
        else assert.equal(projection.columns.Data, null, `${result.name}/${stageName} SQL NULL Data column`);
      }
      assert.equal(stage.mapper.data.isNull, !result.requiresJson, `${result.name}/${stageName} Data policy`);
      assert.equal(stage.stored.data.isNull, !result.requiresJson, `${result.name}/${stageName} stored Data policy`);
      assert.deepEqual(Object.keys(stage.stored.relations),
        ['providers', 'lockedFields', 'trailerTypes', 'images', 'links', 'userData', 'ancestors', 'values', 'maps'],
        `${result.name}/${stageName}`);
    }
  }
  // This validates all 172 random image IDs, all 400 random ItemValue IDs,
  // their cross-stage aliases and the complete 91-object relationship graph.
  assert.equal(normalizeRelationshipIds(native.results).length, 91);
});

function manifestKind(propertyType) {
  if (propertyType === 'System.Boolean') return 'bool';
  if (propertyType === 'System.Int32') return 'int';
  if (propertyType === 'System.Guid') return 'guid';
  if (propertyType === 'System.DateTime') return 'date';
  if (propertyType === 'System.String') return 'string';
  if (propertyType === 'System.String[]' || propertyType.includes('IReadOnlyList`1[[System.String,')) return 'string[]';
  if (propertyType === 'System.Guid[]') return 'guid[]';
  if (propertyType.endsWith('LinkedChild[]')) return 'LinkedChild[]';
  if (propertyType.endsWith('TrailerType[]')) return 'TrailerType[]';
  if (propertyType === 'System.DayOfWeek[]') return 'DayOfWeek[]';
  if (propertyType.includes('ConcurrentBag`1[[MediaBrowser.Controller.Entities.BaseItem,')) return 'entity[]';
  if (propertyType.includes('IReadOnlyList`1[[MediaBrowser.Model.Entities.MediaUrl,')) return 'MediaUrl[]';
  if (propertyType.includes('IReadOnlyList`1[[MediaBrowser.Model.Entities.PlaylistUserPermissions,')) return 'PlaylistUserPermissions[]';
  const nullable = propertyType.match(/^System\.Nullable`1\[\[(.*?), /u)?.[1];
  const name = nullable ?? propertyType;
  return new Map([
    ['System.Boolean', 'bool'], ['System.Int32', 'int'], ['System.Int64', 'long'], ['System.Double', 'double'],
    ['System.Guid', 'guid'], ['Jellyfin.Data.Enums.CollectionType', 'CollectionType'],
    ['MediaBrowser.Model.Drawing.ImageOrientation', 'Orientation'],
    ['MediaBrowser.Model.Entities.IsoType', 'IsoType'], ['MediaBrowser.Model.Entities.SeriesStatus', 'SeriesStatus'],
    ['MediaBrowser.Model.Entities.Video3DFormat', 'Video3DFormat'],
    ['MediaBrowser.Model.MediaInfo.TransportStreamTimestamp', 'Timestamp'],
    ['MediaBrowser.Model.Entities.VideoType', 'VideoType'], ['Jellyfin.Data.Enums.MediaType', 'MediaType'],
    ['MediaBrowser.Controller.Entities.LinkedChildType', 'LinkedChildType'],
  ]).get(name) ?? name.split('.').at(-1);
}

test('full27 typed JSON contract matches every final JsonTypeInfo serializable accessor', () => {
  const manifest = native.jsonPropertyManifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.typeCount, 31);
  assert.equal(manifest.types.reduce((sum, type) => sum + type.serializablePropertyCount, 0), 379);
  assert.equal(manifest.types.flatMap(type => type.serializableProperties).filter(property => property.getterOnly).length, 30);
  assert.deepEqual(manifest.types.flatMap(type => type.serializableProperties)
    .filter(property => property.IsRequired).map(property => [property.declaringType, property.jsonName]),
  [['MediaBrowser.Controller.Entities.ItemImageInfo', 'Path']]);
  for (const definition of input.coreTypes) {
    const expected = manifest.types.find(type => type.fullName === definition.fullName);
    assert.ok(expected, definition.fullName);
    const serializable = expected.serializableProperties.map(property => ({
      name: property.jsonName, kind: manifestKind(property.propertyType), readOnly: property.getterOnly,
    }));
    assert.deepEqual(nativeItemJsonContract(definition.fullName).map(property => ({
      name: property.name, kind: property.kind, readOnly: property.readOnly,
    })), serializable, definition.fullName);
  }
  const nested = new Map(manifest.types.slice(27).map(type => [type.fullName, type.serializableProperties.map(value => value.jsonName)]));
  assert.deepEqual(nested.get('MediaBrowser.Model.Entities.MediaUrl'), ['Url', 'Name']);
  assert.deepEqual(nested.get('MediaBrowser.Controller.Entities.LinkedChild'), ['Path', 'Type', 'LibraryItemId', 'ItemId']);
  assert.deepEqual(nested.get('MediaBrowser.Model.Entities.PlaylistUserPermissions'), ['UserId', 'CanEdit']);
  assert.deepEqual(nested.get('MediaBrowser.Controller.Entities.ItemImageInfo'),
    ['Path', 'Type', 'DateModified', 'Width', 'Height', 'BlurHash']);
});

test('full27 factory accepts only the exact registered CLR discriminators', () => {
  for (const definition of input.coreTypes) {
    const descriptor = nativeItemDescriptor(definition.fullName);
    assert.deepEqual([descriptor.nativeType, descriptor.type, descriptor.requiresJson],
      [definition.fullName, definition.name, definition.requiresJson]);
    assert.equal(newNativeItemEntity(definition.fullName).NativeType, definition.fullName);
  }
  for (const discriminator of ['Movie', 'MediaBrowser.Controller.Entities.Movie', 'Example.Entities.Movie', 'Oracle.Unknown.BaseItem']) {
    assert.throws(() => nativeItemDescriptor(discriminator), TypeError);
    assert.throws(() => newNativeItemEntity(discriminator), TypeError);
  }
});

for (const dialect of ['postgres']) {
  const skip = dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES;
  const actualCoreResults = [];
  for (const [offset, definition] of input.coreTypes.entries()) test(`${dialect}: full27 constructor and DB overlay ${definition.name}`,
    { skip }, async t => {
      const core = await runCoreCase(t, dialect, definition, offset + 1, 'core');
      const malformedKind = definition.requiresJson ? 'malformed' : 'source-malformed';
      const malformed = await runCoreCase(t, dialect, definition, offset + 1, malformedKind, 'bad{');
      actualCoreResults.push(core, malformed);
      assertProjectedEqual(t, core.name, normalizeRelationshipIds(core), normalizeRelationshipIds(resultFor(core.name)), coreProjection);
      assertProjectedEqual(t, malformed.name, normalizeRelationshipIds(malformed), normalizeRelationshipIds(resultFor(malformed.name)), coreProjection);
    });

  for (const boundary of input.boundaryCases) test(`${dialect}: full27 ${boundary.name}`, { skip }, async t => {
    const definition = input.coreTypes.find(value => value.fullName === boundary.fullName);
    const index = input.coreTypes.indexOf(definition) + 1;
    const actual = await runCoreCase(t, dialect, definition, index, boundary.name, boundary.data, {
      forceNullData: boundary.mode === 'sql-null', explicitSkip: boundary.mode === 'explicit-skip',
      configuredSkip: boundary.mode === 'configured-skip', storedTypeOverride: boundary.mode === 'unknown-type' ? boundary.storedType : null,
    });
    actualCoreResults.push(actual);
    assertProjectedEqual(t, actual.name, normalizeRelationshipIds(actual), normalizeRelationshipIds(resultFor(actual.name)), coreProjection);
  });

  test(`${dialect}: all 64 deserialize cases retain globally unique image identities`, { skip }, () => {
    assert.equal(actualCoreResults.length, 64);
    assert.equal(normalizeRelationshipIds(actualCoreResults).length, 64);
  });
}

for (const dialect of ['postgres']) test(`${dialect}: full27 SaveItems created-updated-cleared lifecycle`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const actual = [];
    for (const fullName of input.saveItemsTypes) {
      const definition = input.coreTypes.find(value => value.fullName === fullName);
      actual.push(await runSaveLifecycle(t, dialect, definition, input.coreTypes.indexOf(definition) + 1));
    }
    const expected = input.saveItemsTypes.map(fullName => resultFor(`saveitems-${input.coreTypes.find(value => value.fullName === fullName).name}`));
    assertProjectedEqual(t, 'full27 SaveItems lifecycle', normalizeRelationshipIds(actual), normalizeRelationshipIds(expected),
      values => values.map(saveProjection));
  });
