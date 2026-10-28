import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { pinnedNativeSqliteSchemaFingerprint } from '../../src/database/native-envelope.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { databaseDigest, exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { makeInput, sourceFields, streamFields } from '../library/fixtures/live-tv-media-sources/input.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n';
const plain = value => value instanceof Map ? Object.fromEntries(value) : typeof value === 'bigint' ? Number(value) : value;
const projectSource = source => ({ ...Object.fromEntries(sourceFields.map(name => [name, plain(source[name]) ?? null])),
  DefaultAudioIndexSource: source.DefaultAudioIndexSource ?? 0,
  MediaStreams: source.MediaStreams?.map(stream => Object.fromEntries(streamFields.map(name => [name, stream[name] ?? null]))) ?? null });

test('an actual Native LiveTvChannel mapper URI survives current SQLite, fresh PostgreSQL and reverse SQLite with typed source consumption', {
  skip: !enabled, timeout: 300000,
}, async () => {
  const input = makeInput();
  input.cases = input.cases.filter(sample => sample.name === 'nonempty channel path suppresses the dynamic provider and final placeholder');
  const inputBytes = Buffer.from(encode(input));
  const output = path.join(validationOutputRoot(), 'live-tv-channel-path-native-' + randomUUID());
  await mkdir(output);
  const temporaryRoot = await realpath(tmpdir()), privatePrefix = 'mm-tv-uri-exchange-';
  const privateRoot = await mkdtemp(path.join(temporaryRoot, privatePrefix));
  const inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { passed: false, cleanup: [], inputSha256: hash(inputBytes),
    sampleOrigin: 'tests/library/fixtures/live-tv-media-sources/input.js',
    boundary: 'Actual Native Mapper/source components with controlled tuner/user-data dependencies; current Native SQLite schema and real PostgreSQL exchange. No Native HTTP or built-in Guide HTTP-path generation is claimed.' };
  let current, supplied, source, returned, database, store, links, library, items, failed = false, failure;
  try {
    current = await currentNativeReference();
    supplied = await currentNativeSqliteInputs();
    report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'src/Jellyfin.LiveTv/LiveTvMediaSourceProvider.cs',
    ]);
    const oracle = await recordOracle({ project: 'tests/library/fixtures/live-tv-media-sources/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(oracle.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    assert.deepEqual(native.results.map(result => result.name), input.cases.map(sample => sample.name));
    const expected = native.results[0], uriBytes = Buffer.from(input.cases[0].item.Path);
    assert.equal(expected.row.Type, 'MediaBrowser.Controller.LiveTv.LiveTvChannel');
    assert.deepEqual(Buffer.from(expected.row.Path), uriBytes);
    report.native = expected;
    report.nativeOutputSha256 = hash(nativeBytes);
    report.oracle = { project: oracle.project, passed: oracle.passed, process: oracle.process, sourceFiles: oracle.sourceFiles,
      nativePersistenceOpened: native.nativePersistenceOpened, tunerResponsesControlled: native.tunerResponsesControlled,
      userDataLookupControlled: native.userDataLookupControlled, mediaStreamsOpened: native.mediaStreamsOpened };

    const sourceFile = path.join(privateRoot, 'source.db');
    await copyFile(supplied.filename, sourceFile);
    source = new SqliteDatabase(sourceFile, { requireMigrationHistory: true });
    const columns = new Set(tableDefinition('BaseItems').columns.map(column => column.name));
    const row = postgresTestRow('BaseItems', Object.fromEntries(Object.entries(expected.row).filter(([key]) => columns.has(key))));
    source.insert('BaseItems', row);
    const original = await databaseDigest(source);
    const state = await discoverInstanceState({ instanceRoot: supplied.initialization.root });
    const instanceBinding = { serverId: state.identity.serverId, originIdentityDigest: state.identity.digest };
    database = await createPostgresTestDatabase(null, 'tv_uri_exchange');
    const imported = await transferDatabase(source, database, { instanceBinding, portableMountContract: supplied.receipt.mountContract });
    assert.deepEqual(imported.tables, original);
    assert.deepEqual(await databaseDigest(database), original);
    report.exchange = { input: { sha256: supplied.receipt.input.sha256, build: supplied.initialization.build, bindings: supplied.inputs },
      instanceBinding, schema: { fingerprint: source.schema.fingerprint, history: source.schema.history }, original,
      imported: { tables: imported.tables, verified: imported.verified }, uri: [] };
    const observeUri = async (owner, label) => {
      const [stored] = await owner.rows('BaseItems', { where: { Id: row.Id }, consumer: 'exchange', limit: 1 });
      const bytes = nativeTextBytes(stored.Path);
      assert.deepEqual(bytes, uriBytes);
      report.exchange.uri.push({ owner: label, bytes: bytes.length, sha256: hash(bytes), raw: bytes.toString('base64') });
    };
    await observeUri(source, 'current-native-sqlite-copy');
    await observeUri(database, 'fresh-postgres');

    store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    library = new LibraryService({ store, linkedChildren: links, fileSystem: testFileSystem,
      serverId: state.identity.serverId, configuration: {} });
    items = new ItemCreationService({ store, library, linkedChildren: links,
      loadContext() { throw new Error('The declared source consumer does not create metadata.'); } });
    library.itemCreation = items;
    const item = await items.getItemById(row.Id);
    const actual = { staticSources: (await library.getLiveMediaSources(item)).map(projectSource),
      playbackSources: (await library.getMediaSources(item.Id)).map(projectSource) };
    report.node = actual;
    assert.deepEqual(actual.staticSources, expected.staticSources);
    assert.deepEqual(actual.playbackSources, expected.playbackSources);
    assert.deepEqual(await databaseDigest(database), original);
    await items.close(); items = undefined;
    await library.close(); library = undefined;
    await links.flushReleases(); await links.close(); links = undefined;
    report.typedConsumersClosed = true;

    const returnedFile = path.join(privateRoot, 'returned.db');
    const exported = await exportCurrentSqlite(database, returnedFile);
    returned = new SqliteDatabase(returnedFile, { readOnly: true, requireMigrationHistory: true });
    const roundTrip = await databaseDigest(returned);
    assert.deepEqual(roundTrip, original);
    assert.deepEqual(returned.schema.history, source.schema.history);
    assert.equal(returned.schema.fingerprint, pinnedNativeSqliteSchemaFingerprint);
    await observeUri(returned, 'reverse-sqlite');
    assert.deepEqual(await databaseDigest(source), original);
    assert.deepEqual(await databaseDigest(database), original);
    report.exchange.exported = { tables: exported.tables, verified: exported.verified, actual: roundTrip,
      schema: { fingerprint: returned.schema.fingerprint, history: returned.schema.history } };
    report.passed = true;
  } catch (error) {
    failed = true; failure = error;
    report.failure = { name: error?.name, message: error?.message, code: error?.code, stack: error?.stack };
  } finally {
    const cleanupFailures = [];
    const attempt = async (owner, operation) => {
      try { await operation(); report.cleanup.push({ owner, closed: true }); return true; }
      catch (error) { cleanupFailures.push(error); report.cleanup.push({ owner, closed: false, error: error?.message }); return false; }
    };
    const ownersReleased = [];
    ownersReleased.push(await attempt('typed-item-service', () => items?.close()));
    ownersReleased.push(await attempt('library', () => library?.close()));
    ownersReleased.push(await attempt('linked-item-releases', () => links?.flushReleases()));
    ownersReleased.push(await attempt('linked-items', () => links?.close()));
    ownersReleased.push(await attempt('source-sqlite', () => source?.close()));
    ownersReleased.push(await attempt('returned-sqlite', () => returned?.close()));
    ownersReleased.push(await attempt('postgres-schema-and-pool', () => dropPostgresTestDatabase(database)));
    ownersReleased.push(await attempt('domain-store', () => store?.close()));
    await attempt('designated-inputs', () => current?.finish());
    if (supplied) await attempt('current-sqlite-input', async () => {
      const after = await currentNativeSqliteInputs();
      assert.deepEqual(after.inputs, supplied.inputs);
      report.originalInputUnchanged = true;
    });
    let privateInputsRemoved = false;
    if (ownersReleased.every(Boolean)) privateInputsRemoved = await attempt('private-sqlite-copies', async () => {
      const resolved = await realpath(privateRoot), metadata = await lstat(privateRoot);
      if (resolved !== privateRoot || path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(privatePrefix)
        || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('The private SQLite cleanup path no longer belongs to this fixture.');
      await rm(resolved, { recursive: true, force: true });
      report.privateInputsRemoved = true;
    });
    if (!privateInputsRemoved) report.privateInputsRetained = { root: privateRoot,
      reason: ownersReleased.every(Boolean) ? 'Private directory removal failed.' : 'One or more real owners did not finish closing.' };
    if (cleanupFailures.length) {
      failure = failed ? new AggregateError([failure, ...cleanupFailures], failure?.message, { cause: failure })
        : cleanupFailures.length === 1 ? cleanupFailures[0] : new AggregateError(cleanupFailures, 'URI exchange fixture cleanup failed.');
      failed = true; report.passed = false;
    }
    await writeFile(path.join(output, 'report.json'), encode(report), { flag: 'wx' });
  }
  if (failed) throw failure;
  assert.equal(report.passed, true);
});
