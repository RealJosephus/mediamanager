import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { userRootItem } from '../../src/library/collection-membership.js';
import { releaseCachedFolderChildren } from '../../src/library/folder-cache.js';
import { observeNativeItemLinkOwnership } from '../../src/library/native-item-entity.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { rootInitializationInput as input } from './fixtures/user-root-initialization-current/input.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { completeSnapshot } from '../helpers/library-exchange-state.js';
import { errorRecord, removePrivateRoot } from '../http/fixtures/item-collections-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = [
  'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/ResolverHelper.cs',
  'Emby.Server.Implementations/Library/MediaSourceManager.cs',
  'Emby.Server.Implementations/Library/Resolvers/GenericFolderResolver.cs',
  'Emby.Server.Implementations/Library/Resolvers/SpecialFolderResolver.cs',
  'Emby.Server.Implementations/Library/Resolvers/FolderResolver.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
  'Emby.Server.Implementations/ServerApplicationPaths.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
  'MediaBrowser.Controller/Entities/BaseItemExtensions.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs', 'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
];
const projection = item => item ? {
  id: item.Id.toLowerCase(), nativeType: item.NativeType, name: item.Name, path: item.Path,
  parentId: item.ParentId.toLowerCase(), IsRoot: item.IsRoot, IsFolder: item.IsFolder, IsLocked: item.IsLocked,
  overview: item.Overview, tags: [...item.Tags], genres: [...item.Genres], providerIds: { ...item.ProviderIds },
  dateCreated: dateText(item.DateCreated), dateModified: dateText(item.DateModified), dateLastSaved: dateText(item.DateLastSaved),
} : null;
const apply = (item, values) => Object.assign(item, {
  Name: values.name, Overview: values.overview, Tags: [...values.tags],
  DateCreated: values.dateCreated, DateModified: values.dateModified, DateLastSaved: values.dateLastSaved,
  ...(values.providerIds ? { ProviderIds: { ...values.providerIds } } : {}),
});
function readProjection(value, program, { fresh = false } = {}) {
  if (!value) return value;
  const result = { ...value, path: value.path === program ? '$program'
    : value.path?.startsWith(program + path.sep) ? '$program' + value.path.slice(program.length) : value.path };
  for (const field of ['dateCreated', 'dateModified', 'dateLastSaved']) result[field] = dateTicks(result[field]).toString();
  if (fresh) delete result.dateCreated;
  return result;
}
function rowProjection(table, row) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const value = row[column.name], type = column.clrType.replace('?', '');
    return [column.name, value == null ? null : type === 'Guid' ? idKey(value)
      : type === 'DateTime' ? dateTicks(value).toString() : column.name === 'Data' ? parseLosslessJson(value) : value];
  }));
}
async function rootStored(database, id) {
  id = nativeGuid(id);
  return {
    rows: (await database.rows('BaseItems', { where: { Id: id } })).map(row => rowProjection('BaseItems', row)),
    providers: (await database.rows('BaseItemProviders', { where: { ItemId: id } }))
      .map(row => rowProjection('BaseItemProviders', row)).sort((left, right) => left.ProviderId.localeCompare(right.ProviderId, 'en')),
  };
}

test('current native UserRoot initialization preserves first unsaved singleton, lookup failures, real directory recovery and cold persistence', {
  skip: !enabled, timeout: 360000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'user-root-initialization-' + randomUUID()); assertValidationOutputChild(output);
  await mkdir(output, { recursive: true });
  const temporaryParent = await realpath(tmpdir()), privateRoot = await realpath(await mkdtemp(path.join(temporaryParent, 'mm-root-init-')));
  const inputFile = path.join(output, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), captures: [], cases: [], cleanup: {},
    passed: false, phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Same-run current LibraryManager constructor/GetUserRootFolder, actual SpecialFolderResolver/ManagedFileSystem/repository/SQLite saving, independently repeated; production PG runtime singleton/read/save/cold consumption and all-table unchanged read/cancel controls. No Native full-host HTTP or metadata-provider execution claim.' };
  let current, first, failed = false, failure;
  const unchanged = async (filename, expected) => {
    const value = await describeFile(filename); assert.equal(value.available, true); assert.equal(value.sha256, expected, filename); return value;
  };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceDatabase = await describeFile(current.sourceDatabase); report.sourceBindings = await current.sourceBindings(sources);
    for (const label of ['first', 'repeat']) {
      const receipt = await recordOracle({ project: 'tests/library/fixtures/user-root-initialization-current/Oracle.csproj',
        output: path.join(output, label), environment: current.environment,
        args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native-' + label), current.sourceDatabase] });
      const filename = path.join(output, label, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, receipt, output: await describeFile(filename) });
      assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.sourceSha256, report.sourceDatabase.sha256);
      assert.deepEqual(native.results.map(value => value.name), input.cases); assert.equal(native.schemaCreated, false);
      for (const assembly of native.assemblies) await unchanged(assembly.filename, assembly.sha256);
      for (const library of native.nativeLibraries) await unchanged(library.filename, library.sha256);
      for (const result of native.results) {
        await unchanged(result.initialDatabaseFilename, result.initialDatabaseSha256);
        await unchanged(result.databaseFilename, result.databaseSha256);
        assert.deepEqual(result.afterRead, result.before); assert.deepEqual(result.beforeCold, result.afterSaved);
        const initialRootRows = result.initialRows.filter(row => idKey(row.Id) === idKey(result.id));
        assert.equal(initialRootRows.length, ['stored', 'wrong-type'].includes(result.name) ? 1 : 0);
        if (result.name === 'wrong-type') {
          assert.deepEqual(result.initialChildren.map(value => idKey(value.id)), [idKey(result.childIds.original)]);
          assert.deepEqual(result.warmChildren.map(value => idKey(value.id)), [idKey(result.childIds.original)]);
          assert.deepEqual(result.reloadedChildren.map(value => idKey(value.id)).sort(),
            [result.childIds.original, result.childIds.late].map(idKey).sort());
        }
        const fresh = result.name !== 'stored';
        if (fresh) assert.ok(Date.parse(result.initial.dateCreated) >= Date.parse(result.startedAt)
          && Date.parse(result.initial.dateCreated) <= Date.parse(result.finishedAt));
        if (first) {
          const expected = first.results.find(value => value.name === result.name);
          for (const field of ['initial', 'warm', 'registered', 'cold', 'byIdBeforeSave']) assert.deepEqual(
            readProjection(result[field], result.programDataPath, { fresh: fresh && field === 'initial' }),
            readProjection(expected[field], expected.programDataPath, { fresh: fresh && field === 'initial' }), result.name + ':' + field);
          assert.deepEqual(result.concurrent.map(value => readProjection(value, result.programDataPath, { fresh })),
            expected.concurrent.map(value => readProjection(value, expected.programDataPath, { fresh })), result.name + ':concurrent');
          assert.deepEqual(result.repeated.map(value => readProjection(value, result.programDataPath, { fresh })),
            expected.repeated.map(value => readProjection(value, expected.programDataPath, { fresh })), result.name + ':repeated');
          assert.equal(Boolean(result.directoryFailure), Boolean(expected.directoryFailure));
        }
      }
      if (!first) first = native;
    }
    for (const native of first.results) {
      t.signal.throwIfAborted();
      let source, database, runtime, reopened, coldRuntime, stopObserver, primary, closed = false;
      const observedOwners = [], errors = [];
      const actual = { name: native.name, initial: null, repeated: [], cleanup: {}, runtimeErrors: errors };
      report.cases.push(actual);
      try {
        // Both captures retain their stopped SQLite originals. Only this exact
        // first capture's owned program directory becomes the Node control.
        assert.equal(path.dirname(native.programDataPath), path.join(privateRoot, 'native-first', native.name));
        assert.equal(path.basename(native.programDataPath), 'program');
        await rm(native.programDataPath, { recursive: true });
        await mkdir(native.programDataPath);
        const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
        const accessRoot = '/user-root-program', portableMountContract = { mounts: [{ mountId: 'user-root-program',
          identityRoot: native.programDataPath, accessRoot, pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
        const storageConfiguration = path.join(path.dirname(native.programDataPath), 'node-storage.json');
        const definition = {
          instances: [{ id: 'program', type: 'local', config: { root: native.programDataPath, writable: true } }],
          mounts: [{ path: accessRoot, instanceId: 'program', capabilities: {
            create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
          prefixes: [{ identityRoot: native.programDataPath, accessRoot, style, caseSensitive,
            returnAccess: 'All original component identities remain in this isolated owned program namespace.' }],
        };
        await writeFile(storageConfiguration, JSON.stringify(definition, null, 2) + '\n', { flag: 'wx' });
        actual.storageInput = { portableMountContract, definition, filename: storageConfiguration };
        source = new SqliteDatabase(native.initialDatabaseFilename, { readOnly: true, requireMigrationHistory: true });
        database = await createPostgresTestDatabase(null, 'user_root_init');
        actual.transfer = await transferDatabase(source, database, { instanceBinding: {
          serverId: input.serverId, originIdentityDigest: native.initialDatabaseSha256 }, portableMountContract });
        source.close(); source = null;
        runtime = await createRuntime({ database, programDataPath: native.programDataPath, serverId: input.serverId,
          storageConfiguration, portableMountContract,
          configuration: { ...input.configuration, UICulture: 'en-US' }, onError: error => errors.push(errorRecord(error)) });
        assert.equal(runtime.storage.identityMap.resolve({ identityPath: path.join(native.programDataPath, 'children', 'original'), style }),
          accessRoot + '/children/original', 'The actual Local VFS consumes the same declared ordinary Folder namespace.');
        actual.beforeRead = await completeSnapshot(database, { signal: t.signal });
        if (native.name === 'lookup-failure') {
          const original = runtime.itemCreation.getItemById.bind(runtime.itemCreation);
          let pending = true;
          runtime.itemCreation.getItemById = (id, ...args) => {
            if (pending && idKey(id) === idKey(native.id)) { pending = false; throw Object.assign(new Error('controlled root repository lookup'), { code: 'controlled-read' }); }
            return original(id, ...args);
          };
        }
        const directory = path.join(native.programDataPath, 'root', 'default');
        if (native.name === 'blocked-directory') {
          // Runtime storage preparation can create this owned empty directory.
          // Install the actual file collision before the first measured getter.
          await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await writeFile(directory, input.blockedBytes, { flag: 'wx' });
          const state = await completeSnapshot(database, { signal: t.signal });
          await assert.rejects(runtime.libraryScanHost.getUserRootFolder());
          assert.equal(await readFile(directory, 'utf8'), input.blockedBytes);
          assert.deepEqual(await completeSnapshot(database, { signal: t.signal }), state);
          await rm(directory);
          actual.directoryFailure = { status: 'rejected', bytesUnchanged: true };
        }
        const startedAt = Date.now(), concurrent = await Promise.all(Array.from({ length: 8 }, () => runtime.libraryScanHost.getUserRootFolder()));
        const root = concurrent[0], finishedAt = Date.now();
        stopObserver = observeNativeItemLinkOwnership(root, event => observedOwners.push(event.count));
        actual.initial = projection(root);
        const fresh = native.name !== 'stored';
        if (fresh) assert.ok(Date.parse(actual.initial.dateCreated) >= startedAt && Date.parse(actual.initial.dateCreated) <= finishedAt);
        assert.deepEqual(readProjection(actual.initial, native.programDataPath, { fresh }),
          readProjection(native.initial, native.programDataPath, { fresh }), native.name + ':first root');
        root.Overview = input.warmOverview;
        actual.concurrent = concurrent.map(projection);
        assert.deepEqual(actual.concurrent.map(value => readProjection(value, native.programDataPath, { fresh })),
          native.concurrent.map(value => readProjection(value, native.programDataPath, { fresh })), native.name + ':concurrent initial readers');
        const repeated = await Promise.all(Array.from({ length: 8 }, () => runtime.libraryScanHost.getUserRootFolder()));
        actual.repeated = repeated.map(projection);
        assert.deepEqual(actual.repeated.map(value => readProjection(value, native.programDataPath, { fresh })),
          native.repeated.map(value => readProjection(value, native.programDataPath, { fresh })), native.name + ':warm repeated');
        assert.equal((await stat(directory)).isDirectory(), true);
        actual.byIdBeforeSave = projection(await runtime.itemCreation.getItemById(native.id));
        assert.deepEqual(readProjection(actual.byIdBeforeSave, native.programDataPath),
          readProjection(native.byIdBeforeSave, native.programDataPath), native.name + ':separate ID lookup');
        await runtime.store.run(async db => {
          for (const baseRows of [[], await db.rows('BaseItems', { where: { Id: nativeGuid(native.id) } })]) {
            const state = await runtime.library.load(db, null, { includeUserData: false, baseRows });
            try { assert.equal(userRootItem(state)?.Overview, input.warmOverview, 'Implicit root reads consume the actual warm singleton, including an unrelated stored type at its ID.'); }
            finally { await state.dispose({ session: db }); }
          }
        });
        actual.afterRead = await completeSnapshot(database, { signal: t.signal });
        assert.deepEqual(actual.afterRead, actual.beforeRead, native.name + ':getters do not persist a root');
        if (native.name === 'wrong-type') {
          const children = () => runtime.libraryScanHost.withChildSnapshot(root, async source => {
            const values = [];
            for await (const page of source.pages()) for (const child of page) values.push(projection(child));
            return values;
          });
          actual.initialChildren = await children();
          source = new SqliteDatabase(native.databaseFilename, { readOnly: true, requireMigrationHistory: true });
          const late = source.rows('BaseItems', { where: { Id: nativeGuid(native.childIds.late) } });
          assert.equal(late.length, 1); actual.lateChildInput = late[0];
          await database.insert('BaseItems', late[0]);
          source.close(); source = null;
          actual.warmChildren = await children();
          releaseCachedFolderChildren(root);
          await runtime.linkedChildren.flushOwnedReleases();
          actual.reloadedChildren = await children();
          for (const field of ['initialChildren', 'warmChildren', 'reloadedChildren']) assert.deepEqual(
            actual[field].map(value => readProjection(value, native.programDataPath)),
            native[field].map(value => readProjection(value, native.programDataPath)), field);
        }
        actual.beforeCancelledSave = await completeSnapshot(database, { signal: t.signal });
        apply(root, input.saved);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(runtime.itemCreation.saveItems([root], { signal: cancelled.signal }));
        assert.deepEqual(await completeSnapshot(database, { signal: t.signal }), actual.beforeCancelledSave, 'Cancelled root saving retains every table.');
        await runtime.itemCreation.saveItems([root], { signal: t.signal });
        actual.warm = projection(root);
        assert.deepEqual(readProjection(actual.warm, native.programDataPath), readProjection(native.warm, native.programDataPath),
          native.name + ':complete selected live values after real saving');
        runtime.itemCreation.registerItem(root);
        root.Overview = input.warmOverview;
        actual.registered = projection(await runtime.itemCreation.getItemById(native.id));
        assert.deepEqual(readProjection(actual.registered, native.programDataPath), readProjection(native.registered, native.programDataPath),
          'Explicit native registration publishes the live root.');
        root.Overview = input.saved.overview;
        source = new SqliteDatabase(native.databaseFilename, { readOnly: true, requireMigrationHistory: true });
        actual.stored = await rootStored(database, native.id); actual.nativeStored = await rootStored(source, native.id);
        assert.equal(actual.stored.rows.length, 1); assert.equal(actual.nativeStored.rows.length, 1);
        assert.equal(actual.nativeStored.providers.length, 1);
        actual.persistedRaw = { BaseItems: await database.rows('BaseItems', { where: { Id: nativeGuid(native.id) } }),
          BaseItemProviders: await database.rows('BaseItemProviders', { where: { ItemId: nativeGuid(native.id) } }) };
        assert.deepEqual(actual.stored, actual.nativeStored, native.name + ':all root columns/Data/provider values');
        source.close(); source = null;
        const schema = database.schemaName;
        actual.beforeClose = await completeSnapshot(database, { signal: t.signal });
        await runtime.close(); closed = true; actual.cleanup.runtimeClosed = true;
        assert.equal(observedOwners.at(-1), 0, 'Actual runtime shutdown releases the singleton and registry branches.');
        stopObserver.release(); stopObserver = null;
        reopened = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
        coldRuntime = await createRuntime({ database: reopened, programDataPath: native.programDataPath, serverId: input.serverId,
          storageConfiguration, portableMountContract,
          configuration: { ...input.configuration, UICulture: 'en-US' }, onError: error => errors.push(errorRecord(error)) });
        assert.equal(coldRuntime.storage.identityMap.resolve({ identityPath: path.join(native.programDataPath, 'children', 'original'), style }),
          accessRoot + '/children/original', 'The cold runtime retains the same original Folder path binding.');
        actual.cold = projection(await coldRuntime.libraryScanHost.getUserRootFolder());
        assert.deepEqual(readProjection(actual.cold, native.programDataPath), readProjection(native.cold, native.programDataPath), native.name + ':cold stored root');
        assert.deepEqual(await completeSnapshot(reopened, { signal: t.signal }), actual.beforeClose, 'Cold initialization retains every stored table.');
        actual.expectedLookupFailure = native.name === 'lookup-failure';
        assert.equal(errors.length, actual.expectedLookupFailure ? 1 : 0, 'Only the supplied initial lookup failure is observed.');
      } catch (error) { primary = error; throw error; }
      finally {
        const failures = [], attempt = async (name, operation) => { try { await operation(); actual.cleanup[name] = true; } catch (error) { actual.cleanup[name] = errorRecord(error); failures.push(error); } };
        await attempt('sourceClosed', () => source?.close());
        await attempt('runtimeClosed', () => closed ? undefined : runtime?.close());
        await attempt('coldRuntimeClosed', () => coldRuntime?.close());
        stopObserver?.release();
        await attempt('postgresRemoved', () => dropPostgresTestDatabase(reopened ?? database));
        if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures], primary?.message ?? 'Root fixture cleanup failed.', { cause: primary ?? failures[0] });
      }
    }
    t.signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  finally {
    const failures = [], attempt = async (name, operation) => { try { await operation(); report.cleanup[name] = true; } catch (error) { report.cleanup[name] = errorRecord(error); failures.push(error); } };
    await attempt('nativeInputsUnchanged', () => current?.finish());
    if (current) await attempt('sourceDatabaseUnchanged', () => unchanged(current.sourceDatabase, report.sourceDatabase.sha256));
    await attempt('neutralInputUnchanged', () => unchanged(inputFile, sha(inputBytes)));
    for (const source of report.sourceBindings ?? []) await attempt('source:' + path.basename(source.path), () => unchanged(source.path, source.sha256));
    for (const result of first?.results ?? []) {
      await attempt(result.name + ':initialSqliteUnchanged', () => unchanged(result.initialDatabaseFilename, result.initialDatabaseSha256));
      await attempt(result.name + ':savedSqliteUnchanged', () => unchanged(result.databaseFilename, result.databaseSha256));
    }
    // Native and Node owners have already closed; only this exact private tree
    // is removed. Original same-run source/recordings stay in their own roots.
    if (report.cases.every(value => value.cleanup.runtimeClosed && value.cleanup.coldRuntimeClosed)) {
      await attempt('privateRootRemoved', () => removePrivateRoot(privateRoot, temporaryParent, 'mm-root-init-'));
    }
    if (failures.length) { failure = new AggregateError([...(failed ? [failure] : []), ...failures], 'Root initialization verification and cleanup failed.', { cause: failed ? failure : failures[0] }); failed = true; }
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; }
    report.passed = !failed; if (failed) report.error = errorRecord(failure);
    let text = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    if (process.env.MEDIAMANAGER_TEST_POSTGRES) text = text.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]');
    await writeFile(path.join(output, 'report.json'), text + '\n');
    t.diagnostic(JSON.stringify({ report: path.join(output, 'report.json'), passed: report.passed }));
  }
  if (failed) throw failure;
});
