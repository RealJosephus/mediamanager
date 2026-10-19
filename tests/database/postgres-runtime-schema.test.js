import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { lowerInvariant } from '../../src/core/identity.js';
import invariantCharUpperMapping from '../../src/core/resources/invariant-char-upper.json' with { type: 'json' };
import invariantLowerMapping from '../../src/core/resources/invariant-lower.json' with { type: 'json' };
import unicodeLetterNumberRangeBounds from '../../src/core/resources/unicode-letter-number-ranges.json' with { type: 'json' };
import ordinalIgnoreCaseMapping from '../../src/storage/resources/ordinal-ignore-case.json' with { type: 'json' };
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { nativeTextBytes, nativeTextPathKey, nativeTextOrdinalIgnoreCaseKey, nativeTextFromProjection } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
const bytes = value => value === null ? null : nativeTextBytes(value);
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeModel, quoteIdentifier as q } from '../../src/database/model.js';
import { buildPostgresItemPageQuery } from '../../src/database/postgres-item-query.js';
import { postgresVersionFamilyKey } from '../../src/database/postgres-query-expressions.js';
import {
  createPostgresRuntimeFunctionSql,
  createPostgresRuntimeIndexSql,
  postgresCleanValueFunctionName,
  postgresInvariantCharUpperFunctionName,
  postgresInvariantLowerFunctionName,
  postgresNativeJsonEnumFunctionName,
  postgresNativeJsonGuidKeyFunctionName,
  postgresNativePathKeyFunctionName,
  postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName,
  postgresRuntimeFunctions,
  postgresRuntimeIndexNames,
  postgresRuntimeIndexes,
  postgresRuntimeSchemaFingerprint,
  postgresRuntimeSchemaFingerprintKey,
  withoutPostgresRuntimeIndexes,
} from '../../src/database/postgres-runtime-schema.js';
import { nativePathKey } from '../../src/library/native-path.js';
import { cleanValue } from '../../src/library/records.js';
import { upperInvariant } from '../../src/users/native.js';
import { fixtureRow } from './fixtures.js';

const table = name => nativeModel.tables.find(entry => entry.name === name);

test('PostgreSQL CleanValue uses stable repository-owned Unicode Letter/Number ranges', async () => {
  assert.equal(unicodeLetterNumberRangeBounds.length, 1556);
  assert.equal(unicodeLetterNumberRangeBounds.length / 2, 778);
  assert.equal(unicodeLetterNumberRangeBounds.reduce((count, bound, index) =>
    count + (index % 2 ? bound - unicodeLetterNumberRangeBounds[index - 1] : 0), 0), 147596);
  assert.deepEqual(unicodeLetterNumberRangeBounds.slice(0, 12),
    [48, 58, 65, 91, 97, 123, 170, 171, 178, 180, 181, 182]);
  assert.deepEqual(unicodeLetterNumberRangeBounds.slice(-12),
    [178208, 183982, 183984, 191457, 191472, 192094, 194560, 195102, 196608, 201547, 201552, 210042]);
  assert.equal(createHash('sha256').update(JSON.stringify(unicodeLetterNumberRangeBounds)).digest('hex'),
    '83d96873cb45435769c11ad5d1118905618c55765e70bb38d025971fb420a7a7');

  for (let index = 0; index < unicodeLetterNumberRangeBounds.length; index += 2) {
    const start = unicodeLetterNumberRangeBounds[index];
    const end = unicodeLetterNumberRangeBounds[index + 1];
    assert.ok(Number.isInteger(start) && Number.isInteger(end));
    assert.ok(start >= 0 && start < end && end <= 0x110000);
    if (index > 0) assert.ok(unicodeLetterNumberRangeBounds[index - 1] < start,
      'ranges are ordered, disjoint, and maximally joined');
  }

  const source = await readFile(new URL('../../src/database/postgres-runtime-schema.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\\p\{[LN]\}/u,
    'runtime schema construction must not depend on the host Unicode property tables');
  assert.doesNotMatch(source, /String\.fromCodePoint|codePoint\s*<=\s*0x10ffff/u,
    'runtime schema construction must not enumerate Unicode at module import time');
  const recordsSource = await readFile(new URL('../../src/library/records.js', import.meta.url), 'utf8');
  assert.doesNotMatch(recordsSource, /\\p\{[LN]\}/u,
    'the JavaScript CleanValue authority must use the same frozen ranges as PostgreSQL');
});

function runtimeSnapshot() {
  return {
    namespaces: [{ nspname: 'fixture' }],
    columns: [{ table_name: 'BaseItems', column_name: 'Id' }],
    constraints: [],
    indices: postgresRuntimeIndexes.map(entry => ({
      tablename: entry.table,
      indexname: entry.name,
      indexdef: createPostgresRuntimeIndexSql('fixture', entry),
    })),
    indexState: postgresRuntimeIndexes.map(entry => ({
      table_name: entry.table,
      index_name: entry.name,
      indisunique: false,
      indisprimary: false,
      indisexclusion: false,
      indimmediate: true,
      indisclustered: false,
      indisvalid: true,
      indcheckxmin: false,
      indisready: true,
      indislive: true,
      indisreplident: false,
    })),
    relations: postgresRuntimeIndexes.map(entry => ({
      relname: entry.name,
      relkind: 'i',
      relpersistence: 'p',
      relreplident: 'n',
    })),
    rules: [],
    inheritance: [],
    sequences: [],
    sequenceOwnership: [],
    rowSecurity: [],
    policies: [],
    triggers: [],
    functions: postgresRuntimeFunctions.map(entry => ({
      function_name: entry.name,
      input_types: entry.inputTypes,
      result_type: entry.resultType,
      language: entry.language,
      volatility: 'i',
      is_strict: true,
      security_definer: false,
      leakproof: false,
      parallel_safety: 's',
      kind: 'f',
      owner: 'fixture',
      privileges: null,
      executable: true,
      configuration: ['search_path=pg_catalog'],
      source: createPostgresRuntimeFunctionSql('fixture', entry).split('$mm_runtime_function$')[1],
      definition: createPostgresRuntimeFunctionSql('fixture', entry),
    })),
  };
}

test('PostgreSQL runtime indexes have stable names and stay outside the native schema fingerprint', () => {
  assert.equal(new Set(postgresRuntimeIndexNames).size, postgresRuntimeIndexNames.length);
  assert.ok(postgresRuntimeIndexNames.every(name => Buffer.byteLength(name) <= 63));

  const snapshot = runtimeSnapshot();
  const fingerprint = postgresRuntimeSchemaFingerprint(snapshot);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  const native = withoutPostgresRuntimeIndexes(snapshot);
  assert.deepEqual(native.indices, []);
  assert.deepEqual(native.indexState, []);
  assert.deepEqual(native.relations, []);
  assert.deepEqual(native.functions, []);
  assert.deepEqual(native.columns, snapshot.columns, 'native table metadata is untouched');

  const invalid = structuredClone(snapshot);
  invalid.indexState[0].indisvalid = false;
  assert.throws(() => postgresRuntimeSchemaFingerprint(invalid), /is not usable/);
  const drifted = structuredClone(snapshot);
  drifted.indices[0].indexdef += ' WHERE false';
  assert.notEqual(postgresRuntimeSchemaFingerprint(drifted), fingerprint);
  const mutable = structuredClone(snapshot);
  mutable.functions[0].volatility = 'v';
  assert.throws(() => postgresRuntimeSchemaFingerprint(mutable), /not the verified immutable definition/);
  const invariantFunction = postgresRuntimeFunctions.find(entry => entry.name === postgresInvariantLowerFunctionName);
  assert.ok(invariantFunction);
  assert.equal(invariantFunction.language, 'sql');
  assert.match(invariantFunction.body, /^SELECT (?:mm_text_utf8_key|mm_projected_utf16_key)\(pg_catalog\.translate\(mm_bytes_text_projection\(source\),/u);
  assert.ok(invariantFunction.body.includes(Object.keys(invariantLowerMapping).join('')));
  assert.ok(invariantFunction.body.includes(Object.values(invariantLowerMapping).join('')));
  assert.doesNotMatch(postgresInvariantLowerFunctionName, /(?:^|_)v[0-9]+(?:_|$)/u);
  assert.match(createPostgresRuntimeFunctionSql('fixture', invariantFunction),
    /LANGUAGE sql\nIMMUTABLE STRICT PARALLEL SAFE\nSET search_path = pg_catalog/u);
  const upperFunction = postgresRuntimeFunctions.find(entry => entry.name === postgresInvariantCharUpperFunctionName);
  assert.ok(upperFunction);
  assert.equal(upperFunction.language, 'sql');
  assert.ok(upperFunction.body.includes(Object.keys(invariantCharUpperMapping).join('')));
  assert.ok(upperFunction.body.includes(Object.values(invariantCharUpperMapping).join('')));
  assert.doesNotMatch(postgresInvariantCharUpperFunctionName, /(?:^|_)v[0-9]+(?:_|$)/u);
  const ordinalFunction = postgresRuntimeFunctions.find(entry => entry.name === postgresOrdinalIgnoreCaseKeyFunctionName);
  assert.ok(ordinalFunction);
  assert.equal(ordinalFunction.language, 'sql');
  assert.match(ordinalFunction.body, /^SELECT (?:mm_text_utf8_key|mm_projected_utf16_key)\(pg_catalog\.translate\(mm_bytes_text_projection\(source\),/u);
  assert.ok(ordinalFunction.body.includes(Object.keys(ordinalIgnoreCaseMapping).join('')));
  assert.ok(ordinalFunction.body.includes(Object.values(ordinalIgnoreCaseMapping).join('')));
  assert.doesNotMatch(postgresOrdinalIgnoreCaseKeyFunctionName, /(?:^|_)v[0-9]+(?:_|$)/u);
  assert.match(createPostgresRuntimeFunctionSql('fixture', ordinalFunction),
    /LANGUAGE sql\nIMMUTABLE STRICT PARALLEL SAFE\nSET search_path = pg_catalog/u);
  const cleanFunction = postgresRuntimeFunctions.find(entry => entry.name === postgresCleanValueFunctionName);
  assert.ok(cleanFunction);
  assert.equal(cleanFunction.language, 'plpgsql');
  assert.match(cleanFunction.body, /letter_number_ranges CONSTANT integer\[\]/u);
  assert.doesNotMatch(postgresCleanValueFunctionName, /(?:^|_)v[0-9]+(?:_|$)/u);
  assert.match(createPostgresRuntimeFunctionSql('fixture', cleanFunction),
    /LANGUAGE plpgsql\nIMMUTABLE STRICT PARALLEL SAFE\nSET search_path = pg_catalog/u);
  for (const [name, resultType, inputTypes] of [[postgresSafeNativeItemDataFunctionName, 'json', 'bytea, bytea'],
    [postgresSafeInt32FunctionName, 'integer', 'bytea'],
    [postgresNativeJsonEnumFunctionName, 'bytea', 'json, text'],
    [postgresNativeJsonGuidKeyFunctionName, 'text', 'json']]) {
    const definition = postgresRuntimeFunctions.find(entry => entry.name === name);
    assert.ok(definition);
    assert.equal(definition.language, 'plpgsql');
    assert.equal(definition.inputTypes, inputTypes);
    assert.equal(definition.resultType, resultType);
    assert.doesNotMatch(name, /(?:^|_)v[0-9]+(?:_|$)/u);
    assert.match(createPostgresRuntimeFunctionSql('fixture', definition),
      /LANGUAGE plpgsql\nIMMUTABLE STRICT PARALLEL SAFE\nSET search_path = pg_catalog/u);
  }

  for (const definition of postgresRuntimeIndexes) {
    const sql = createPostgresRuntimeIndexSql('fixture', definition);
    assert.ok(sql.startsWith('CREATE INDEX'));
    assert.doesNotMatch(sql, /COLLATE "C"|lower\("/u, 'raw native fields do not enter PostgreSQL text operations');
  }

});

function planIndexNames(value, result = new Set()) {
  if (Array.isArray(value)) for (const entry of value) planIndexNames(entry, result);
  else if (value && typeof value === 'object') {
    if (typeof value['Index Name'] === 'string') result.add(value['Index Name']);
    for (const entry of Object.values(value)) planIndexNames(entry, result);
  }
  return result;
}

test('deferred PostgreSQL open leaves runtime indexes untouched until explicit initialization', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `runtime_deferred_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  let database;
  t.after(async () => {
    try { await database?.close(); } catch { /* Raw cleanup below remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
    finally { await cleanup.end(); }
  });

  const installedNames = async () => (await database.client.query(
    'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname',
    [schema, postgresRuntimeIndexNames]
  )).rows.map(row => row.indexname);
  const functionNames = postgresRuntimeFunctions.map(entry => entry.name);
  const installedFunctions = async () => (await database.client.query(
    'SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND proname = ANY($2::text[]) ORDER BY proname',
    [schema, functionNames]
  )).rows.map(row => row.proname);

  database = await PostgresDatabase.open({
    connectionString,
    schema,
    create: true,
    max: 2,
    deferRuntimeSchemaInitialization: true,
  });
  assert.equal(await database.getState(postgresRuntimeSchemaFingerprintKey), undefined);
  assert.deepEqual(await installedNames(), []);
  assert.deepEqual(await installedFunctions(), []);
  assert.equal(await database.preflight(), true);
  await database.close();

  database = await PostgresDatabase.open({
    connectionString,
    schema,
    max: 2,
    deferRuntimeSchemaInitialization: true,
  });
  assert.equal(await database.getState(postgresRuntimeSchemaFingerprintKey), undefined);
  assert.deepEqual(await installedNames(), []);
  assert.deepEqual(await installedFunctions(), []);

  const initialized = await database.initializeRuntimeSchema();
  assert.match(initialized.fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(initialized), ['fingerprint']);
  assert.equal(await database.getState(postgresRuntimeSchemaFingerprintKey), initialized.fingerprint);
  assert.deepEqual(await installedNames(), [...postgresRuntimeIndexNames].sort());
  assert.deepEqual(await installedFunctions(), [...functionNames].sort());
  assert.equal(await database.preflight(), true);
});

test('independent PostgreSQL pools serialize first runtime initialization and reopen cleanly', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `runtime_concurrent_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const databases = new Set();
  t.after(async () => {
    await Promise.allSettled([...databases].map(database => database.close()));
    const cleanup = new pg.Pool({ connectionString });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
    finally { await cleanup.end(); }
  });

  const open = async options => {
    const database = await PostgresDatabase.open({ connectionString, schema, max: 2, ...options });
    databases.add(database);
    return database;
  };
  const creator = await open({ create: true, deferRuntimeSchemaInitialization: true });
  const peer = await open({ deferRuntimeSchemaInitialization: true });
  assert.equal(await creator.getState(postgresRuntimeSchemaFingerprintKey), undefined);
  assert.equal(await peer.getState(postgresRuntimeSchemaFingerprintKey), undefined);

  const [creatorResult, peerResult] = await Promise.all([
    creator.initializeRuntimeSchema(),
    peer.initializeRuntimeSchema(),
  ]);
  assert.match(creatorResult.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(peerResult.fingerprint, creatorResult.fingerprint,
    'both pools observe the fingerprint written by the single lock owner');
  assert.equal(await creator.preflight(), true);
  assert.equal(await peer.preflight(), true);

  const installedIndexes = (await creator.client.query(
    'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname',
    [schema, postgresRuntimeIndexNames]
  )).rows.map(row => row.indexname);
  assert.deepEqual(installedIndexes, [...postgresRuntimeIndexNames].sort(),
    'concurrent initialization installs each runtime index exactly once');
  const installedFunctions = await creator.client.query(`SELECT p.oid::text AS oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.proname = ANY($2::text[])`,
  [schema, postgresRuntimeFunctions.map(entry => entry.name)]);
  assert.equal(installedFunctions.rowCount, postgresRuntimeFunctions.length,
    'concurrent initialization installs one identity for every runtime function');

  await Promise.all([creator.close(), peer.close()]);
  const [reopenedCreator, reopenedPeer] = await Promise.all([open({}), open({})]);
  assert.equal(await reopenedCreator.getState(postgresRuntimeSchemaFingerprintKey), creatorResult.fingerprint);
  assert.equal(await reopenedPeer.getState(postgresRuntimeSchemaFingerprintKey), creatorResult.fingerprint);
  assert.equal(await reopenedCreator.preflight(), true);
  assert.equal(await reopenedPeer.preflight(), true);
});

test('PostgreSQL preflight reads concurrent runtime initialization from one catalog snapshot', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `runtime_preflight_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const databases = new Set();
  t.after(async () => {
    await Promise.allSettled([...databases].map(database => database.close()));
    const cleanup = new pg.Pool({ connectionString });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
    finally { await cleanup.end(); }
  });

  const open = async options => {
    const database = await PostgresDatabase.open({
      connectionString,
      schema,
      max: 2,
      deferRuntimeSchemaInitialization: true,
      ...options,
    });
    databases.add(database);
    return database;
  };
  const initializer = await open({ create: true });
  const observer = await open({});
  const query = observer.client.query.bind(observer.client);
  let catalogRead;
  const catalogReadPromise = new Promise(resolve => { catalogRead = resolve; });
  let initializationFinished;
  const initializationFinishedPromise = new Promise(resolve => { initializationFinished = resolve; });
  let paused = false;
  observer.client.query = async (...args) => {
    const result = await query(...args);
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    const values = typeof args[0] === 'string' ? args[1] : args[0].values;
    if (!paused && values?.[0] === schema && text.includes('FROM pg_catalog.pg_proc p')) {
      paused = true;
      catalogRead();
      await initializationFinishedPromise;
    }
    return result;
  };

  const preflight = observer.preflight();
  await catalogReadPromise;
  try {
    await initializer.initializeRuntimeSchema();
  } finally {
    initializationFinished();
  }
  assert.equal(await preflight, true,
    'preflight must not combine a pre-initialization catalog snapshot with the committed fingerprint');
  observer.client.query = query;
  assert.equal(await observer.preflight(), true,
    'a later snapshot observes and validates the completed runtime schema');
});

test('real PostgreSQL initializes its runtime indexes once and keeps production predicates indexed', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `runtime_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  let database;
  t.after(async () => {
    try { await database?.close(); } catch { /* Raw cleanup below remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
    finally { await cleanup.end(); }
  });

  database = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });
  assert.match(await database.getState(postgresRuntimeSchemaFingerprintKey), /^[a-f0-9]{64}$/u);
  const installed = await database.client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname`, [schema, postgresRuntimeIndexNames]);
  assert.deepEqual(installed.rows.map(row => row.indexname), [...postgresRuntimeIndexNames].sort());

  const parent = fixtureRow(table('BaseItems'));
  const child = {
    ...parent,
    Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ParentId: parent.Id,
    TopParentId: parent.Id,
    OwnerId: null,
    PrimaryVersionId: null,
    PresentationUniqueKey: 'runtime-schema-child',
    Path: 'Q:\\Runtime\\draft\\..\\Movie',
  };
  const alternate = {
    ...child,
    Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab',
    ParentId: null,
    PrimaryVersionId: child.Id.replaceAll('-', ''),
    PresentationUniqueKey: 'runtime-schema-alternate',
  };
  await database.insert('BaseItems', parent);
  await database.insert('BaseItems', child);
  await database.insert('BaseItems', alternate);
  await database.insert('AncestorIds', { ItemId: child.Id, ParentItemId: parent.Id });
  await database.insert('LinkedChildren', { ParentId: parent.Id, SortOrder: 1, ChildId: child.Id, ChildType: 0 });

  const nativePathSamples = [
    null,
    '',
    '.',
    './a/../',
    '../a/../../b//',
    '/srv//media/draft/.././Movie//',
    'relative\\backslash/child',
    'Q:/MÉDIA//äcASE/draft/.././library///Movie\\\\',
    '//server/share///äUDIO/./draft/../Series\\',
    '\\\\?\\C:\\media\\draft\\..\\Movie\\',
    '//?/UNC/server/share/draft/../Movie',
  ];
  for (const path of nativePathSamples) {
    const actual = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresNativePathKeyFunctionName)}($1::bytea) AS value`, [bytes(path)]
    )).rows[0].value;
    assert.deepEqual(actual, nativeTextPathKey(path),
      `the indexed PostgreSQL key matches nativePathKey for ${JSON.stringify(path)}`);
  }

  for (const [source, expected] of [[null, null], ['', {}], ['bad{', {}], ['null', {}], ['[]', {}],
    ['42', {}], ['{"value":1e2}', { value: 100 }]]) {
    const value = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresSafeNativeItemDataFunctionName)}($1::bytea, $2::bytea) AS value`,
      [bytes('MediaBrowser.Controller.Entities.Movies.Movie'), bytes(source)]
    )).rows[0].value;
    assert.deepEqual(decodeProjectionJson(value), expected, `safe JSON object boundary handles ${JSON.stringify(source)}`);
  }
  const nativeDataSamples = [
    ['MediaBrowser.Controller.Entities.TV.Episode',
      '{"AirsAfterSeasonNumber":2,"Width":"bad"}', {}],
    ['MediaBrowser.Controller.Entities.Video',
      '{"VideoType":"BluRay","Width":"bad"}', {}],
    ['MediaBrowser.Controller.Playlists.Playlist',
      `{"OwnerUserId":"${parent.Id}","PlaylistMediaType":"bogus"}`, {}],
    ['MediaBrowser.Controller.Entities.TV.Series',
      '{"Status":"Ended","AirDays":"bad"}', {}],
    ['MediaBrowser.Controller.Entities.TV.Episode',
      '{"Width":"bad","Width":2,"AirsAfterSeasonNumber":2}', {}],
    ['MediaBrowser.Controller.Entities.TV.Episode',
      '{"IsHD":{},"Unknown":{"bad":true},"AirsAfterSeasonNumber":"+2"}',
      { IsHD: {}, Unknown: { bad: true }, AirsAfterSeasonNumber: '+2' }],
    ['MediaBrowser.Controller.Playlists.Playlist',
      `{"OwnerUserId":"${parent.Id}","PlaylistMediaType":"Video",`
        + `"Shares":[{"UserId":"${child.Id}","CanEdit":"bad"}]}`, {}],
    ['MediaBrowser.Controller.Playlists.Playlist',
      '{"OwnerUserId":42,"PlaylistMediaType":"Video"}', {}],
    ['MediaBrowser.Controller.Playlists.Playlist',
      `{"OwnerUserId":"${parent.Id}","PlaylistMediaType":"Video",`
        + '"Shares":[{"UserId":{},"CanEdit":true}]}', {}],
    ['MediaBrowser.Controller.Entities.CollectionFolder',
      '{"PhysicalFolderIds":[42]}', {}],
    ['MediaBrowser.Controller.Entities.TV.Episode',
      '{"AirsAfterSeasonNumber":1e2}', {}],
    ['MediaBrowser.Controller.Entities.TV.Series',
      '{"Status":"Ended","Unknown":"\\u0000"}', { Status: 'Ended', Unknown: '\u0000' }],
    ['MediaBrowser.Controller.Entities.TV.Series',
      '{"DisplayOrder":"before\\u0000after","Unknown\\u0000Key":"value\\u0000"}',
      { DisplayOrder: 'before\u0000after', 'Unknown\u0000Key': 'value\u0000' }],
    ['MediaBrowser.Controller.Entities.Movies.Movie',
      '{"SubtitleFiles":["before\\u0000after"],"LinkedAlternateVersions":'
        + '[{"Path":"nested\\u0000path","Type":"Manual","Unknown\\u0000Key":"value\\u0000"}]}',
      {
        SubtitleFiles: ['before\u0000after'],
        LinkedAlternateVersions: [{ Path: 'nested\u0000path', Type: 'Manual', 'Unknown\u0000Key': 'value\u0000' }],
      }],
  ];
  for (const [nativeType, source, expected] of nativeDataSamples) {
    const value = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresSafeNativeItemDataFunctionName)}($1::bytea, $2::bytea) AS value`,
      [bytes(nativeType), bytes(source)]
    )).rows[0].value;
    assert.deepEqual(decodeProjectionJson(value), expected,
      `typed native Data gate handles ${nativeType}: ${source.slice(0, 80)}`);
  }
  await assert.rejects(database.client.query(
    `SELECT ${q(schema)}.${q(postgresSafeNativeItemDataFunctionName)}($1::bytea, $2::bytea)`,
    [bytes('MediaBrowser.Controller.Playlists.Playlist'), bytes('{"OwnerUserId":"not-a-guid"}')]
  ), error => error?.code === 'MM001' && /Invalid GUID/u.test(error.message),
  'Guid.Parse failures remain non-fallback failures like native deserialization');
  await assert.rejects(database.client.query(
    `SELECT ${q(schema)}.${q(postgresSafeNativeItemDataFunctionName)}($1::bytea, $2::bytea)`,
    [bytes('MediaBrowser.Controller.Playlists.Playlist'),
      bytes(`{"OwnerUserId":"${parent.Id}","Shares":[{"UserId":"not-a-guid","CanEdit":true}]}`)]
  ), error => error?.code === 'MM001' && /Invalid GUID/u.test(error.message),
  'nested Guid.Parse string failures remain non-fallback failures');
  const integerSamples = [
    ['0', 0], ['+42', 42], ['-2147483648', -2147483648],
    ['2147483647', 2147483647], ['2147483648', null],
    ['9223372036854775807', null], ['9223372036854775808', null],
    ['9'.repeat(10000), null], ['1e2', null], ['1.0', null], [' true ', null],
  ];
  for (const [source, int32] of integerSamples) {
    const row = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresSafeInt32FunctionName)}($1::bytea) AS int32`, [bytes(source)])).rows[0];
    assert.equal(row.int32, int32, `safe Int32 boundary handles ${JSON.stringify(source)}`);
  }
  const enumSamples = [
    ['"ended"', 'SeriesStatus', 'Ended'], ['1', 'SeriesStatus', 'Ended'],
    ['"bluray"', 'VideoType', 'BluRay'], ['3', 'VideoType', 'BluRay'],
    ['"1"', 'IsoType', 'BluRay'], ['"halfsidebyside"', 'Video3DFormat', 'HalfSideBySide'],
    ['""', 'IsoType', null], ['99', 'VideoType', '99'],
  ];
  for (const [source, kind, expected] of enumSamples) {
    const row = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresNativeJsonEnumFunctionName)}($1::json, $2::text) AS value`,
      [source, kind])).rows[0];
    assert.equal(row.value?.toString('utf8') ?? null, expected,
      `native enum normalization handles ${kind} ${source}`);
  }
  const guidKey = parent.Id.replaceAll('-', '').toLowerCase();
  const guidSamples = [parent.Id, guidKey.toUpperCase(), `{${parent.Id}}`, `(${parent.Id})`,
    '{0x00000000,0x0000,0x0000,{0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00}}'];
  const guidExpected = [guidKey, guidKey, guidKey, guidKey, '0'.repeat(32)];
  for (const [index, source] of guidSamples.entries()) {
    const row = (await database.client.query(
      `SELECT ${q(schema)}.${q(postgresNativeJsonGuidKeyFunctionName)}(to_json($1::text)) AS value`,
      [source])).rows[0];
    assert.equal(row.value, guidExpected[index],
      `native GUID normalization handles ${source}`);
  }

  const invariantSample = `${Object.keys(invariantLowerMapping).join('')}\u0130 already-lower \u{1F642}`;
  const invariantResult = await database.client.query(
    `SELECT ${q(schema)}.${q(postgresInvariantLowerFunctionName)}($1::bytea) AS value`, [bytes(invariantSample)]
  );
  assert.equal(invariantResult.rows[0].value?.toString('utf8') ?? null, lowerInvariant(invariantSample),
    'the PostgreSQL runtime function applies the complete native invariant mapping code point by code point');
  const sharpS = (await database.client.query(`SELECT lower($1::text COLLATE "C") AS database_lower,
    ${q(schema)}.${q(postgresInvariantLowerFunctionName)}($2::bytea) AS invariant_lower`, ['\u1E9E', bytes('\u1E9E')])).rows[0];
  assert.equal(sharpS.invariant_lower.toString('utf8'), '\u00DF');
  assert.notEqual(sharpS.database_lower, sharpS.invariant_lower.toString('utf8'),
    'database-locale lower is not a substitute for the native invariant mapping');
  const ordinalSample = `${Object.keys(ordinalIgnoreCaseMapping).join('')}\u0130 mixed Case \u{1F642}`;
  const ordinalResult = await database.client.query(
    `SELECT ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}($1::bytea) AS value`, [bytes(ordinalSample)]
  );
  assert.deepEqual(ordinalResult.rows[0].value, nativeTextOrdinalIgnoreCaseKey(ordinalSample),
    'the PostgreSQL runtime function applies the complete ordinal-ignore-case mapping code point by code point');
  const upperSample = `${Object.keys(invariantCharUpperMapping).join('')} mixed Case \u{1F642}`;
  const upperResult = await database.client.query(
    `SELECT ${q(schema)}.${q(postgresInvariantCharUpperFunctionName)}($1::bytea) AS value`, [bytes(upperSample)]
  );
  assert.equal(upperResult.rows[0].value?.toString('utf8') ?? null, upperInvariant(upperSample),
    'the PostgreSQL runtime function applies the complete invariant character-upper mapping');
  for (const sample of [null, '', '   ', 'RÖCK', 'Æther—東京 １２', 'İzleyici', 'БА', 'År',
    '¡¿', 'x\ufeffy', 'A\u{1F600}B', "  L'été... déjà-vu  "]) {
    const cleanResult = await database.client.query(
      `SELECT ${q(schema)}.${q(postgresCleanValueFunctionName)}($1::bytea) AS value`, [bytes(sample)]
    );
    assert.equal(cleanResult.rows[0].value?.toString('utf8') ?? null, cleanValue(sample),
      `the PostgreSQL CleanValue key matches JavaScript for ${JSON.stringify(sample)}`);
  }

  const explain = sql => database.transaction(async session => {
    await session.client.query('SET LOCAL enable_seqscan = off');
    return (await session.client.query(`EXPLAIN (FORMAT JSON, COSTS OFF) ${sql}`)).rows[0]['QUERY PLAN'];
  }, { readOnly: true, isolation: 'read-committed' });
  const assertPlanUses = async (sql, name) => {
    assert.ok(planIndexNames(await explain(sql)).has(name), `${name} must support its production predicate`);
  };
  const parentKey = parent.Id.replaceAll('-', '').toLowerCase();
  const childKey = child.Id.replaceAll('-', '').toLowerCase();
  await database.insert('Peoples', {
    Id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    Name: '\u1E9EMITH',
    PersonType: 'Actor',
  });
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."Peoples"
    WHERE ${q(schema)}.${q(postgresInvariantLowerFunctionName)}("Name") = decode('c39f6d697468','hex')
      AND "PersonType" IS NOT DISTINCT FROM 'Actor'`,
  'mm_runtime_people_name_type_invariant_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE substring(${nativeTextSql(schema).projection('"Type"')} from '[^.]+$') = 'MusicArtist'
      AND ${q(schema)}.${q(postgresInvariantLowerFunctionName)}("Name") = '\u00DFmith'
    ORDER BY ("ParentId" IS NULL), "SortName" ASC NULLS FIRST, "Id" ASC`,
  'mm_runtime_baseitems_music_artist_name_invariant_idx');
  assert.ok(planIndexNames(await explain(`SELECT "Id" FROM ${q(schema)}."BaseItems" WHERE ${nativeTextSql(schema).guidLower('"Id"')} = lower('${child.Id}')`))
    .has('mm_runtime_baseitems_id_lower_idx'));
  assert.ok(planIndexNames(await explain(`SELECT "Id" FROM ${q(schema)}."BaseItems" WHERE ${nativeTextSql(schema).guidLower('"ParentId"')} = lower('${parent.Id}') ORDER BY "SortName" ASC NULLS FIRST, "Id" ASC LIMIT 5`))
    .has('mm_runtime_baseitems_parent_lower_sort_idx'));
  const ancestorLookupIndexes = planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."AncestorIds" WHERE ${nativeTextSql(schema).guidLower('"ParentItemId"')} = lower('${parent.Id}') AND ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}')`));
  assert.ok(ancestorLookupIndexes.has('mm_runtime_ancestor_parent_item_lower_idx')
    || ancestorLookupIndexes.has('mm_runtime_ancestor_item_parent_lower_idx'),
  'a fully constrained ancestor lookup can use either covering expression index');
  assert.ok(planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."AncestorIds" WHERE ${nativeTextSql(schema).guidLower('"ParentItemId"')} >= '' ORDER BY ${nativeTextSql(schema).guidLower('"ParentItemId"')}, ${nativeTextSql(schema).guidLower('"ItemId"')}`))
    .has('mm_runtime_ancestor_parent_item_lower_idx'),
  'the parent-leading ancestor expression index supports its distinct range/order access path');
  assert.ok(planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."LinkedChildren" WHERE ${nativeTextSql(schema).guidLower('"ParentId"')} = lower('${parent.Id}') AND ${nativeTextSql(schema).guidLower('"ChildId"')} = lower('${child.Id}')`))
    .has('mm_runtime_linked_children_parent_child_lower_idx'));
  assert.ok(planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."LinkedChildren" WHERE ${nativeTextSql(schema).guidLower('"ChildId"')} = lower('${child.Id}') AND "ChildType" = 0`))
    .has('mm_runtime_linked_children_child_parent_lower_idx'));
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE ${nativeTextSql(schema).guidLower('"OwnerId"')} = lower('${parent.Id}')`,
  'mm_runtime_baseitems_owner_lower_idx');
  const familyRows = await database.client.query(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE ${postgresVersionFamilyKey(schema, '"Id"', '"PrimaryVersionId"')} = '${childKey}' ORDER BY "Id"`);
  assert.deepEqual(familyRows.rows.map(row => row.Id.toString('utf8')), [child.Id, alternate.Id],
    'D-format Id and N-format PrimaryVersionId resolve to one runtime family key');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE ${postgresVersionFamilyKey(schema, '"Id"', '"PrimaryVersionId"')} = '${childKey}'`,
  'mm_runtime_baseitems_version_family_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE ${nativeTextSql(schema).guidLower('COALESCE("SeasonId", "ParentId")')} = lower('${parent.Id}')`,
  'mm_runtime_baseitems_season_parent_lower_idx');
  const itemValueLookupIndexes = planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."ItemValuesMap" WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}') AND ${nativeTextSql(schema).guidLower('"ItemValueId"')} = lower('${parent.Id}')`));
  assert.ok(itemValueLookupIndexes.has('mm_runtime_item_values_map_item_value_lower_idx')
    || itemValueLookupIndexes.has('mm_runtime_item_values_map_value_item_lower_idx'));
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."ItemValuesMap"
    WHERE ${nativeTextSql(schema).guidLower('"ItemValueId"')} = lower('${parent.Id}')`,
  'mm_runtime_item_values_map_value_item_lower_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."ItemValuesMap"
    WHERE "ItemValueId" = '${parent.Id}'`,
  'mm_runtime_item_values_map_value_item_raw_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."Peoples"
    WHERE ${nativeTextSql(schema).guidLower('"Id"')} = lower('${parent.Id}')`,
  'mm_runtime_people_id_lower_idx');
  await assertPlanUses(`SELECT "PeopleId" FROM ${q(schema)}."PeopleBaseItemMap"
    WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}')`,
  'mm_runtime_people_map_item_people_lower_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."PeopleBaseItemMap"
    WHERE ${nativeTextSql(schema).guidLower('"PeopleId"')} = lower('${parent.Id}')`,
  'mm_runtime_people_map_people_item_lower_idx');
  await assertPlanUses(`SELECT "Path" FROM ${q(schema)}."BaseItemImageInfos"
    WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}') AND "ImageType" = 0`,
  'mm_runtime_image_infos_item_type_lower_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE ${q(schema)}.${q(postgresNativePathKeyFunctionName)}("Path")
      = ANY(ARRAY[decode('${nativeTextPathKey('Q:/Runtime/Movie').toString('hex')}','hex')]::bytea[])`,
  'mm_runtime_baseitems_native_path_key_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."BaseItemProviders"
    WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}')
      AND ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}("ProviderId")
        = ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}('tmdb')`,
  'mm_runtime_providers_item_provider_ordinal_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."BaseItemProviders"
    WHERE ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}("ProviderId")
        = ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}('tmdb')
      AND ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}("ProviderValue")
        = ${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}('42')`,
  'mm_runtime_providers_provider_value_ordinal_idx');
  assert.ok(planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."UserData" WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}') AND ${nativeTextSql(schema).guidLower('"UserId"')} = lower('${parent.Id}')`))
    .has('mm_runtime_user_data_item_user_rating_lower_idx'));
  assert.ok(planIndexNames(await explain(`SELECT "ItemId" FROM ${q(schema)}."UserData" WHERE ${nativeTextSql(schema).guidLower('"UserId"')} = lower('${parent.Id}') AND "PlaybackPositionTicks" > 0`))
    .has('mm_runtime_user_data_user_resume_item_lower_idx'));
  assert.ok(planIndexNames(await explain(`SELECT "ItemId" FROM ${q(schema)}."UserData" WHERE ${nativeTextSql(schema).guidLower('"UserId"')} = lower('${parent.Id}') AND "Played" IS TRUE`))
    .has('mm_runtime_user_data_user_played_item_lower_idx'));
  assert.ok(planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."MediaStreamInfos" WHERE ${nativeTextSql(schema).guidLower('"ItemId"')} = lower('${child.Id}') AND "StreamType" = 1 AND "Language" = 'eng'`))
    .has('mm_runtime_media_stream_item_type_language_lower_idx'));

  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE replace(${nativeTextSql(schema).guidLower('"Id"')}, '-', '') = ANY(ARRAY['${childKey}']::text[])`,
  'mm_runtime_baseitems_id_normalized_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE replace(${nativeTextSql(schema).guidLower('"ParentId"')}, '-', '') = '${parentKey}'
    ORDER BY "SortName" ASC NULLS FIRST, "Id" ASC LIMIT 5`,
  'mm_runtime_baseitems_parent_normalized_sort_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE replace(${nativeTextSql(schema).guidLower('"TopParentId"')}, '-', '') = ANY(ARRAY['${parentKey}']::text[])
    ORDER BY "SortName" ASC NULLS FIRST, "Id" ASC LIMIT 5`,
  'mm_runtime_baseitems_top_parent_normalized_sort_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE replace(${nativeTextSql(schema).guidLower('"OwnerId"')}, '-', '') = ANY(ARRAY['${parentKey}']::text[])`,
  'mm_runtime_baseitems_owner_normalized_idx');
  await assertPlanUses(`SELECT "Id" FROM ${q(schema)}."BaseItems"
    WHERE replace(${nativeTextSql(schema).guidLower('"PrimaryVersionId"')}, '-', '') = ANY(ARRAY['${childKey}']::text[])`,
  'mm_runtime_baseitems_primary_version_normalized_idx');
  const normalizedAncestorIndexes = planIndexNames(await explain(`SELECT 1 FROM ${q(schema)}."AncestorIds"
    WHERE replace(${nativeTextSql(schema).guidLower('"ParentItemId"')}, '-', '') = '${parentKey}'
      AND replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '') = '${childKey}'`));
  assert.ok(normalizedAncestorIndexes.has('mm_runtime_ancestor_parent_item_normalized_idx')
    || normalizedAncestorIndexes.has('mm_runtime_ancestor_item_parent_normalized_idx'));
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."AncestorIds"
    WHERE replace(${nativeTextSql(schema).guidLower('"ParentItemId"')}, '-', '') >= ''
    ORDER BY replace(${nativeTextSql(schema).guidLower('"ParentItemId"')}, '-', ''), replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '')`,
  'mm_runtime_ancestor_parent_item_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."AncestorIds"
    WHERE replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '') >= ''
    ORDER BY replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', ''), replace(${nativeTextSql(schema).guidLower('"ParentItemId"')}, '-', '')`,
  'mm_runtime_ancestor_item_parent_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."LinkedChildren"
    WHERE replace(${nativeTextSql(schema).guidLower('"ParentId"')}, '-', '') = '${parentKey}'
      AND replace(${nativeTextSql(schema).guidLower('"ChildId"')}, '-', '') = '${childKey}'`,
  'mm_runtime_linked_children_parent_child_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."LinkedChildren"
    WHERE replace(${nativeTextSql(schema).guidLower('"ChildId"')}, '-', '') = '${childKey}' AND "ChildType" = 0`,
  'mm_runtime_linked_children_child_parent_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."ItemValuesMap"
    WHERE replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '') = '${childKey}'
      AND replace(${nativeTextSql(schema).guidLower('"ItemValueId"')}, '-', '') = '${parentKey}'`,
  'mm_runtime_item_values_map_item_value_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."ItemValues"
    WHERE "Type" = 4 AND "CleanValue" = 'runtime'
      AND replace(${nativeTextSql(schema).guidLower('"ItemValueId"')}, '-', '') = '${parentKey}'`,
  'mm_runtime_item_values_type_clean_id_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."UserData"
    WHERE replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '') = '${childKey}'
      AND replace(${nativeTextSql(schema).guidLower('"UserId"')}, '-', '') = '${parentKey}'`,
  'mm_runtime_user_data_item_user_rating_normalized_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."UserData"
    WHERE replace(${nativeTextSql(schema).guidLower('"UserId"')}, '-', '') = '${parentKey}' AND "PlaybackPositionTicks" > 0`,
  'mm_runtime_user_data_user_resume_item_normalized_idx');
  await assertPlanUses(`SELECT "ItemId" FROM ${q(schema)}."UserData"
    WHERE replace(${nativeTextSql(schema).guidLower('"UserId"')}, '-', '') = '${parentKey}' AND "Played" IS TRUE`,
  'mm_runtime_user_data_user_played_item_normalized_idx');
  await assertPlanUses(`SELECT 1 FROM ${q(schema)}."MediaStreamInfos"
    WHERE replace(${nativeTextSql(schema).guidLower('"ItemId"')}, '-', '') = '${childKey}'
      AND "StreamType" = 1 AND "Language" = 'eng'`,
  'mm_runtime_media_stream_item_type_language_normalized_idx');
  const itemPage = buildPostgresItemPageQuery(database, {
    sortby: ['SortName'],
    sortorder: ['Ascending'],
    limit: 5,
  }, { scope: { parentId: parent.Id } });
  const itemPagePlan = await database.transaction(async session => {
    await session.client.query('SET LOCAL enable_seqscan = off');
    return (await session.client.query({
      text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${itemPage.text}`,
      values: itemPage.values,
    })).rows[0]['QUERY PLAN'];
  }, { readOnly: true, isolation: 'read-committed' });
  const itemPageIndexes = planIndexNames(itemPagePlan);
  assert.ok(itemPageIndexes.has('mm_runtime_baseitems_parent_normalized_sort_idx'),
    'the real item-page SQL uses the normalized parent scope index');

  const identities = await database.client.query(`SELECT c.relname, c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`, [schema, postgresRuntimeIndexNames]);
  await database.close();
  database = await PostgresDatabase.open({ connectionString, schema, max: 2 });
  const reopened = await database.client.query(`SELECT c.relname, c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`, [schema, postgresRuntimeIndexNames]);
  assert.deepEqual(reopened.rows, identities.rows, 'an idempotent open validates indexes without recreating them');

  await database.client.query(`CREATE OR REPLACE FUNCTION ${q(schema)}.${q(postgresNativePathKeyFunctionName)}(source_bytes bytea)
    RETURNS bytea LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
    AS $tampered$ SELECT decode('74616d7065726564','hex') || source_bytes $tampered$`);
  await database.close();
  database = undefined;
  await assert.rejects(PostgresDatabase.open({ connectionString, schema, max: 2 }),
    /runtime function .* is not the verified immutable definition/,
    'a changed native-path function fails closed before runtime access');

  const repair = new pg.Pool({ connectionString });
  try {
    await repair.query(createPostgresRuntimeFunctionSql(schema, postgresRuntimeFunctions.find(entry => entry.name === postgresNativePathKeyFunctionName))
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  } finally { await repair.end(); }
  database = await PostgresDatabase.open({ connectionString, schema, max: 2 });

  await database.client.query(`DROP INDEX ${q(schema)}.${q(postgresRuntimeIndexNames[0])}`);
  await database.close();
  database = undefined;
  await assert.rejects(PostgresDatabase.open({ connectionString, schema, max: 2 }), /runtime schema is missing indexes/,
    'a verified runtime schema with missing index state fails explicitly instead of silently accepting drift');
});

function decodeProjectionJson(value) {
  if (typeof value === 'string') return nativeTextFromProjection(value);
  if (Array.isArray(value)) return value.map(decodeProjectionJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [nativeTextFromProjection(key), decodeProjectionJson(entry)]));
  return value;
}
