import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRuntime } from '../../../../src/runtime.js';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { PostgresDatabase } from '../../../../src/database/postgres.js';
import { transferDatabase } from '../../../../src/migration/database-transfer.js';
import { idKey } from '../../../../src/library/records.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { newNativeItemEntity, nativeItemDescriptor } from '../../../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../../../src/library/folder-cache.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../../../database/postgres-fixture.js';
import { assignTestLinks, readTestLinks } from '../../collection-test-consumers.js';
import { errorRecord, files, rows, sha, within } from '../../../http/fixtures/item-collections-current/scenario.js';

export { errorRecord, files, rows, sha, within };
export const itemProjection = item => ({ id: idKey(item.Id), nativeType: item.NativeType, name: item.Name,
  isFolder: item.IsFolder, isTypedFolder: nativeItemDescriptor(item.NativeType).family === 'folder',
  parentId: idKey(item.ParentId), officialRating: item.OfficialRating });
export const observedProjection = value => ({ name: value.name, lane: value.lane, value: value.value,
  error: value.error ? { status: value.error.status } : null,
  linksBefore: value.linksBefore, linksAfter: value.linksAfter,
  ...(Object.hasOwn(value, 'collectionsBefore') ? { collectionsBefore: value.collectionsBefore, collectionsAfter: value.collectionsAfter } : {}) });

/** Real transferred SQLite -> PostgreSQL -> createRuntime. Warm assignments
 * are explicit public typed entity inputs, not replacement repository rows. */
export async function openRootScenario(input, native, report) {
  let database, runtime, source, closing, originalQuery, currentCase, held, hostLockFilename;
  const owners = [], observedCollections = new Map(), errors = report.runtimeErrors = [], queries = report.queries = [];
  const root = input.root, style = process.platform === 'win32' ? 'windows' : 'posix';
  const close = () => closing ??= (async () => {
    held?.release.resolve(); const failures = [];
    const attempt = async action => { try { await action(); } catch (error) { failures.push(error); } };
    for (const owner of owners.splice(0)) await attempt(() => owner.release());
    await attempt(() => runtime?.linkedChildren.flushReleases());
    await attempt(() => runtime?.close());
    if (hostLockFilename) await attempt(async () => {
      await assert.rejects(lstat(hostLockFilename), { code: 'ENOENT' });
      if (report.pluginHostLease) report.pluginHostLease.removedAfterRuntimeClose = true;
    });
    if (database && originalQuery) database.client.query = originalQuery;
    await attempt(() => source?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Root navigation owners failed to close.');
  })();
  try {
    source = new SqliteDatabase(native.databaseFilename, { readOnly: true, requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'root_links');
    const mountContract = { mounts: [{ mountId: 'root-links', identityRoot: root, accessRoot: '/root-links', pathStyle: style,
      caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] };
    report.transfer = await transferDatabase(source, database, { instanceBinding: { serverId: input.serverId,
      originIdentityDigest: sha(await readFile(native.databaseFilename)) }, portableMountContract: mountContract });
    source.close(); source = undefined;
    const storageFilename = path.join(root, 'config/storage.json');
    await writeFile(storageFilename, JSON.stringify({
      instances: [{ id: 'root-links', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/root-links', instanceId: 'root-links', root: '/', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true, conditionalWrite: false,
      } }],
      prefixes: [{ identityRoot: root, accessRoot: '/root-links', style, caseSensitive: process.platform !== 'win32',
        purpose: 'library', returnAccess: 'Same isolated absolute identity for native and PG.' }],
    }));
    runtime = await createRuntime({ database, serverId: input.serverId, programDataPath: root, dataPath: path.join(root, 'data'), metadataPath: path.join(root, 'metadata'),
      configurationDirectoryPath: path.join(root, 'config'), configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US',
        MetadataCountryCode: 'US', CacheSize: 1024, EnableCaseSensitiveItemIds: true }, portableMountContract: mountContract,
      storageConfiguration: storageFilename, onError: error => errors.push({ case: currentCase ?? null, ...errorRecord(error) }) });
    hostLockFilename = path.join(root, 'plugins', 'node', 'host.lock');
    assert.equal(runtime.plugins.directory, path.dirname(hostLockFilename));
    const lockBytes = await readFile(hostLockFilename), lock = JSON.parse(lockBytes.toString('utf8'));
    assert.deepEqual(Object.keys(lock).sort(), ['pid', 'token']); assert.equal(lock.pid, process.pid);
    assert.match(lock.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    report.pluginHostLease = { path: 'plugins/node/host.lock', filename: hostLockFilename,
      pid: lock.pid, nonce: lock.token, bytes: lockBytes.length, sha256: sha(lockBytes),
      implementation: { path: 'src/plugins/host.js', sha256: sha(await readFile(new URL('../../../../src/plugins/host.js', import.meta.url))) },
      observedAt: new Date().toISOString(), diagnosticOnly: true };
    assert.equal(typeof runtime.library.loadNavigation, 'function', 'Use the formal production navigation preparation entry.');
    const userRoot = await runtime.itemCreation.getItemById(native.rootIds['user-root']);
    const aggregate = await runtime.itemCreation.getItemById(native.rootIds.aggregate);
    assert.equal(userRoot.Type, 'UserRootFolder'); assert.equal(aggregate.Type, 'AggregateFolder');
    owners.push(runtime.itemCreation.retainItem(userRoot), runtime.itemCreation.retainItem(aggregate));
    // Actual native RootFolder has an empty ConcurrentBag in this component.
    // This exact explicit warm value overrides runtime's registered playlist.
    aggregate.VirtualChildren.splice(0);
    const lookup = async id => {
      const item = await runtime.itemCreation.getItemById(id); assert.ok(item); return item;
    };
    const occurrence = async value => {
      if (value.cached === true) {
        const item = await lookup(value.id); owners.push(runtime.itemCreation.retainItem(item));
        applyValues(item, value);
        await applyOccurrenceRelations(item, value);
        return item;
      }
      const original = value.kind ? null : await lookup(value.id);
      const type = original?.NativeType ?? (value.kind === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
        : value.kind === 'Folder' ? 'MediaBrowser.Controller.Entities.Folder'
          : value.kind === 'Episode' ? 'MediaBrowser.Controller.Entities.TV.Episode'
            : value.kind === 'BoxSet' ? 'MediaBrowser.Controller.Entities.Movies.BoxSet' : null);
      assert.ok(type, 'A fresh occurrence requires an explicit known native type.');
      const item = newNativeItemEntity(type);
      // Match the explicit fresh native occurrence boundary. Repository-only
      // fields are not implicitly copied into either side's new object.
      if (original) for (const name of ['Name', 'Path', 'ParentId', 'OfficialRating', 'Tags']) item[name] = original[name];
      item.Id = value.id; owners.push(runtime.itemCreation.retainItem(item));
      applyValues(item, value);
      await applyOccurrenceRelations(item, value);
      return item;
    };
    const applyOccurrenceRelations = async (item, value) => {
      if (Object.hasOwn(value, 'links')) await assignTestLinks(runtime, item,
        value.links?.map(link => ({ ...link, Path: map(link.Path) })) ?? null);
      if (Object.hasOwn(value, 'children')) {
        assert.equal(item.IsFolder, true);
        setFolderChildren(item, value.children === 'stored' ? null : await Promise.all(value.children.map(occurrence)));
      }
      if (value.track) observedCollections.set(value.track, item);
    };
    const applyValues = (item, value) => {
      for (const [inputName, name] of Object.entries({ name: 'Name', overview: 'Overview', genres: 'Genres', tags: 'Tags',
        tagline: 'Tagline', providerIds: 'ProviderIds', rating: 'OfficialRating', customRating: 'CustomRating', sort: 'ForcedSortName',
        studios: 'Studios', year: 'ProductionYear', index: 'IndexNumber', parentIndex: 'ParentIndexNumber',
        locked: 'IsLocked', virtualItem: 'IsVirtualItem', created: 'DateCreated', premiere: 'PremiereDate', runtime: 'RunTimeTicks',
        communityRating: 'CommunityRating', criticRating: 'CriticRating', parentId: 'ParentId', airsAfterSeason: 'AirsAfterSeasonNumber',
        airsBeforeSeason: 'AirsBeforeSeasonNumber', airsBeforeEpisode: 'AirsBeforeEpisodeNumber' })) if (Object.hasOwn(value, inputName)) {
        const provided = value[inputName];
        item[name] = provided && typeof provided === 'object' ? structuredClone(provided) : provided;
      }
      if (Object.hasOwn(value, 'communityRating') && typeof value.communityRating === 'string') item.CommunityRating = Number(value.communityRating);
      if (Object.hasOwn(value, 'path')) item.Path = map(value.path);
      if (Object.hasOwn(value, 'images')) item.ImageInfos = value.images === null ? null : value.images.map(image => ({
        Path: map(image.path), Type: image.type, DateModified: image.modified, Width: image.width, Height: image.height, BlurHash: image.blurHash }));
    };
    const map = value => value === null ? null : value.replaceAll('{root}', root).replaceAll('/', path.sep);
    const rawLinks = async (folder = userRoot) => {
      const links = await readTestLinks(folder);
      return links === null ? null : links.map(link => ({ ItemId: link.ItemId === null ? null : idKey(link.ItemId), Type: Number(link.Type),
        Path: link.Path ?? null, LibraryItemId: link.LibraryItemId ?? null }));
    };
    const collectionLinks = async () => Object.fromEntries(await Promise.all([...observedCollections]
      .map(async ([name, item]) => [name, await rawLinks(item)])));
    const apply = async (sample, folder = userRoot) => {
      if (Object.hasOwn(sample, 'folderPath')) folder.Path = map(sample.folderPath);
      if (sample.warm) {
        const item = await lookup(sample.warm.id); owners.push(runtime.itemCreation.retainItem(item));
        applyValues(item, sample.warm);
        await applyOccurrenceRelations(item, sample.warm);
      }
      if (Object.hasOwn(sample, 'direct')) setFolderChildren(folder, sample.direct === 'stored' ? null : await Promise.all(sample.direct.map(occurrence)));
      if (Object.hasOwn(sample, 'aggregateChildren')) setFolderChildren(aggregate, sample.aggregateChildren === 'stored' ? null
        : await Promise.all(sample.aggregateChildren.map(occurrence)));
      if (Object.hasOwn(sample, 'collectionsChildren')) {
        const collectionsFolder = await runtime.collections.getCollectionsFolder(false); assert.ok(collectionsFolder);
        owners.push(runtime.itemCreation.retainItem(collectionsFolder));
        setFolderChildren(collectionsFolder, sample.collectionsChildren === 'stored' ? null
          : await Promise.all(sample.collectionsChildren.map(occurrence)));
      }
      if (Object.hasOwn(sample, 'virtual')) aggregate.VirtualChildren.splice(0, aggregate.VirtualChildren.length, ...await Promise.all(sample.virtual.map(occurrence)));
      if (Object.hasOwn(sample, 'replaceLinks')) await assignTestLinks(runtime, folder, sample.replaceLinks?.map(link => ({ ...link, Path: map(link.Path) })) ?? null);
    };
    originalQuery = database.client.query;
    database.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (held && !held.enteredOnce && /^SELECT \* FROM "mm_link_resolution_batch_/u.test(text)) {
        held.enteredOnce = true; held.entered.resolve(); await held.release.promise;
      }
      const result = await originalQuery(...args);
      if (currentCase && /mm_link_resolution_|item-collections-|mm_folder_physical_|mm_folder_winners_|mm_folder_collapse_|mm_native_query_|item_cohorts/u.test(text)) {
        queries.push({ case: currentCase, text, returned: result.rows?.length ?? 0 });
      }
      return result;
    };
    const run = async sample => {
      currentCase = sample.name;
      if (sample.configuration) Object.assign(runtime.configuration, sample.configuration);
      const folder = sample.folder ? await lookup(sample.folder) : userRoot;
      await apply(sample, folder);
      const collectionsBefore = sample.observeCollections ? await collectionLinks() : null;
      const linksBefore = await rawLinks(folder), user = sample.user === null ? null
        : await runtime.users.getUser(input.users.find(row => row.key === sample.user).id);
      let value = null, error = null;
      try {
        if (sample.lane === 'folder') {
          value = JSON.parse(stringifyNativeJson(await runtime.library.queryItems({ ParentId: folder.Id,
            Fields: input.dtoFields, EnableImages: false, EnableUserData: false, ...sample.query }, { user })));
        } else if (sample.lane === 'collections') {
          const result = await runtime.library.getItemCollections(input.target, { user });
          value = result.Items.map(item => idKey(item.Id)).sort();
        } else if (sample.lane === 'dto') {
          const result = await runtime.library.queryItems({ ParentId: userRoot.Id, Fields: input.dtoFields,
            EnableImages: false, EnableUserData: false }, { user });
          assert.equal(result.TotalRecordCount, result.Items.length);
          assert.equal(result.StartIndex, 0);
          value = JSON.parse(stringifyNativeJson(result.Items));
        } else if (sample.lane === 'raw') value = (await runtime.library.getCollectionFolders(await lookup(input.target))).map(itemProjection);
        else value = await runtime.store.run(async session => {
          const state = await runtime.library.loadNavigation(session, user, { includeUserData: false });
          try {
            const values = sample.lane === 'views' ? await runtime.library.userViews.views(state, user,
              { includeHidden: true, includeExternalContent: false }) : runtime.library.rootChildren(state, user);
            return values.map(itemProjection);
          } finally { await state.dispose({ session }); }
        });
      } catch (caught) { error = { type: caught.nativeException ?? caught.name, message: caught.message, status: caught.status ?? 500, stack: caught.stack }; }
      return { name: sample.name, lane: sample.lane, value, error, linksBefore, linksAfter: await rawLinks(folder),
        ...(sample.observeCollections ? { collectionsBefore, collectionsAfter: await collectionLinks() } : {}) };
    };
    const snapshot = async () => ({ database: await rows(database), files: await files(root) });
    const drain = async sample => {
      currentCase = sample ? 'held folder resolution' : 'held root resolution'; held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const preShutdownLock = await readFile(hostLockFilename);
      assert.equal(sha(preShutdownLock), report.pluginHostLease.sha256);
      assert.deepEqual(JSON.parse(preShutdownLock.toString('utf8')), { pid: report.pluginHostLease.pid, token: report.pluginHostLease.nonce });
      report.pluginHostLease.preShutdownIdentityUnchanged = true;
      const user = await runtime.users.getUser(input.users[0].id);
      const read = () => sample ? runtime.library.queryItems({ ParentId: sample.folder, Fields: input.dtoFields,
        EnableImages: false, EnableUserData: false, ...sample.query }, { user }) : runtime.library.getItemCollections(input.target, { user });
      let pending, libraryClosing, runtimeClosing, libraryDone = false, runtimeDone = false;
      try {
        pending = read(); void pending.catch(() => {});
        await within(held.entered.promise, 'admitted real root positive-batch SELECT');
        libraryClosing = runtime.library.close(); libraryClosing.then(() => { libraryDone = true; }, () => { libraryDone = true; });
        await assert.rejects(read(), { status: 503 });
        for (const owner of owners.splice(0)) owner.release(); await runtime.linkedChildren.flushReleases();
        runtimeClosing = runtime.close(); runtimeClosing.then(() => { runtimeDone = true; }, () => { runtimeDone = true; });
        assert.equal(libraryDone, false); assert.equal(runtimeDone, false); held.release.resolve();
        const result = await within(pending, 'held visible root membership query');
        await within(libraryClosing, 'root frame/cohort release'); await within(runtimeClosing, 'runtime/database close');
        assert.equal(database.closed, true); assert.equal(runtime.server.listening, false);
        await assert.rejects(lstat(hostLockFilename), { code: 'ENOENT' });
        report.pluginHostLease.removedAfterRuntimeClose = true; report.pluginHostLease.removedAt = new Date().toISOString();
        const reopened = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
        let afterShutdown; try { afterShutdown = { database: await rows(reopened), files: await files(root) }; } finally { await reopened.close(); }
        return { itemIds: result.Items.map(item => idKey(item.Id)).sort(), newAdmission503: true, heldQueryCompleted: true,
          libraryDrained: libraryDone, runtimeDrained: runtimeDone, databaseClosed: true, pluginHostLeaseRemoved: true,
          independentReopenedConnectionClosed: reopened.closed, afterShutdown };
      } finally { held.release.resolve(); await Promise.allSettled([pending, libraryClosing, runtimeClosing]); held = undefined; }
    };
    return { runtime, database, run, snapshot, drain, close, errors, queries };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
