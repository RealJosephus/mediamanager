import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import * as libraryModule from '../../src/library/index.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver, resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { guid, idKey, dateText } from '../../src/library/records.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { discoveryFixture, ordinal } from './video-discovery-fixture.js';
import { projectDirectoryItem, projectDirectoryResolution, resolveDirectoryVideo } from './directory-video-fixture.js';
import { seedNativeConstructorControl, insertFailure, completeColumns } from './directory-persistence-fixture.js';
import { ensureFixtureDirectory } from './ignore-file-fixture.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import { projectStatePath } from './fixture-state-path.js';

export async function assertDirectoryValidation(t, dialect, sample, expected, {
  reconciliation = false,
  onReroute,
  onRefreshProgress,
  reportProgress,
  metadataScanner = {
    async refreshAccessibleChildren() {},
    async refreshContainer() {}
  }
} = {}) {
  const { FolderValidationService } = libraryModule;
  assert.equal(typeof FolderValidationService, 'function',
    'src/library/index.js must expose the production FolderValidationService boundary');

  const refreshScopes = [];
  let failureParentPath;
  const value = await discoveryFixture(t, dialect, sample, {
    captureDatabaseDeletes: false,
    captureMetadataEvents: !sample.mutation,
    resolveFile: resolveOrdinaryVideoFile,
    // The native fault belongs to DirectoryService.GetFileSystemEntries for
    // the direct child. Raw multi-disc probes from a higher scope do not use
    // that controlled service and must not consume its failure first.
    shouldFailDirectory: () => !sample.recordTraversal || refreshScopes.at(-1)?.Path === failureParentPath
  }), { fixture, loaded, calls } = value;
  if (sample.failDirectory) failureParentPath = path.join(loaded.parent.Path, path.dirname(sample.failDirectory));
  if (sample.recordTraversal) fixture.configuration.LibraryScanFanoutConcurrency = 1;
  await seedNativeConstructorControl(fixture, loaded, sample);
  for (const name of sample.directories) await ensureFixtureDirectory(fixture, '/discovery-write/discovery/' + name);
  if (sample.parentLocked) {
    loaded.parent.IsLocked = true;
    await fixture.database.update('BaseItems', { Id: loaded.parent.Id }, { IsLocked: true });
  }

  // Native setup removes its unrelated parse-oracle owner immediately before
  // invoking ValidateChildren, while retaining the warm parent cache control.
  await fixture.database.delete('BaseItems', { Id: loaded.item.Id });
  await fixture.adapter.delete('/discovery/primary.mkv');
  if (sample.failInsert || sample.failInsertAlternate || sample.failLinks) await insertFailure(fixture, sample);

  const registered = new Map();
  const creator = new ItemCreationService({ ...fixture, registerItem: item => registered.set(idKey(item.Id), item) });
  fixture.library.itemCreation = creator;
  t.after(() => creator.close());
  const saveItems = creator.saveItems.bind(creator);
  creator.saveItems = async (items, options = {}) => {
    calls.push({ action: 'save', items: items.map(item => projectDirectoryItem(item, fixture, sample)),
      cancellable: Boolean(options.signal) });
    return saveItems(items, options);
  };
  fixture.library.on('ItemAdded', event => calls.push({ action: 'event', kind: 'added', id: guid(event.Item.Id) }));
  fixture.library.on('ItemRemoved', event => calls.push({ action: 'event', kind: 'removed', id: guid(event.Item.Id) }));
  if (sample.mutation) fixture.library.on('ItemUpdated', event => {
    calls.push({ action: 'event', kind: 'updated', id: guid(event.Item.Id), reason: event.UpdateReason });
    if (sample.failEvent) throw new Error('Controlled item-updated observer failure');
  });

  const normalize = candidate => projectStatePath(candidate.identityPath, fixture.stateRoot);
  const video = createVideoFileResolver();
  const resolver = { ...video,
    async resolveMultiple(context) {
      calls.push({ action: 'multi', files: context.available.map(normalize),
        collectionType: context.collectionContext?.collectionType ?? null });
      return video.resolveMultiple(context);
    },
    async resolveDirectory(context) {
      if (sample.resolverFailure && context.candidate.identityPath.endsWith(`${path.sep}FilmB`)) {
        calls.push({ action: 'resolve', path: normalize(context.candidate) });
        const error = new Error(`Controlled second-child resolver ${sample.resolverFailure} failure`);
        error.code = sample.resolverFailure;
        throw error;
      }
      const result = await video.resolveDirectory(context);
      calls.push({ action: 'resolve', path: normalize(context.candidate) });
      return result;
    },
    async resolveFile(context) {
      calls.push({ action: 'resolve', path: normalize(context.candidate) });
      const result = await video.resolveFile(context);
      if (result == null) calls.push({ action: 'folder', path: normalize(context.candidate) });
      return result;
    }
  };
  const folder = { id: 'native-folder-dispatch', priority: 1000, nativeTypes: { [folderNativeType]: { isFolder: true } },
    resolveDirectory({ candidate }) { calls.push({ action: 'folder', path: normalize(candidate) }); return null; } };
  const resolverErrors = [];
  const controller = new AbortController();
  const linkedChildReferences = { reroute: async (...args) => {
    if (typeof onReroute === 'function') return onReroute({
      fromId: args[0], toId: args[1], argumentsLength: args.length, fixture, creator, calls
    });
    return [];
  } };
  const deletionLinkedChildReferences = { reroute: async () => [] };
  const refreshes = new ProviderRefreshService({ onError: error => resolverErrors.push(error) });
  let traversalActive = false;
  refreshes.on('RefreshStarted', event => {
    if (traversalActive) {
      refreshScopes.push(event.Item);
      calls.push({ action: 'refresh-start', id: guid(event.Item.Id) });
    }
  });
  refreshes.on('RefreshCompleted', event => {
    if (traversalActive) {
      assert.equal(idKey(refreshScopes.pop()?.Id), idKey(event.Item.Id));
      calls.push({ action: 'refresh-complete', id: guid(event.Item.Id) });
    }
  });
  if (typeof onRefreshProgress === 'function') refreshes.on('RefreshProgress', onRefreshProgress);
  const updates = fixture.host.updates, images = fixture.host.images;
  if (sample.mutation) updates.library = fixture.library;
  if (reconciliation) {
    creator.registerItem(loaded.parent);
    fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator,
      updates, externalData: loaded.videoVersionDiscovery.externalData,
      linkedChildReferences: deletionLinkedChildReferences, now: () => fixture.now });
    const deleteItems = fixture.library.itemDeletion.deleteItems.bind(fixture.library.itemDeletion);
    fixture.library.itemDeletion.deleteItems = async (idsPlan, scope, publishDeletedPage) => {
      const ids = [];
      let after = '';
      while (true) {
        const page = (await scope.database.client.query({
          text: `SELECT requested."Key" FROM (${idsPlan.text}) requested
            WHERE requested."Key" COLLATE "C" > $${idsPlan.values.length + 1} COLLATE "C"
            ORDER BY requested."Key" COLLATE "C" LIMIT 128`, values: [...idsPlan.values, after]
        })).rows;
        ids.push(...page.map(row => guid(row.Key)));
        if (page.length < 128) break;
        after = page.at(-1).Key;
      }
      calls.push({ action: 'delete', ids });
      return deleteItems(idsPlan, scope, publishDeletedPage);
    };
    if (sample.cancelFromCleanup) {
      const external = loaded.videoVersionDiscovery.externalData, cleanup = external.deleteItemFiles.bind(external);
      external.deleteItemFiles = (item, options) => { controller.abort(); return cleanup(item, options); };
    }
  }
  const lifecycle = new ResolvedItemLifecycleHost({ store: fixture.store, loadContext: fixture.loadContext, updates, images });
  const resolverPipeline = new DirectoryItemResolverPipeline({ resolvers: [resolver, folder],
    programDataPath: fixture.stateRoot, configuration: fixture.configuration,
    onError: error => resolverErrors.push(error) });
  const scheduler = new LibraryTaskScheduler({ configuration: fixture.configuration,
    runWorker: operation => fixture.store.runDetached(() => fixture.loadContext.withDetachedScope(operation)) });
  t.after(() => scheduler.close());
  if (typeof metadataScanner === 'function') metadataScanner = metadataScanner({ fixture, loaded, calls, creator, scheduler });
  const validation = new FolderValidationService({
    scheduler,
    store: fixture.store,
    library: fixture.library,
    itemCreation: creator,
    resolvedItemLifecycle: lifecycle,
    vfs: fixture.vfs,
    identityMap: fixture.identityMap,
    ignoreRule: fixture.ignoreRule,
    resolverPipeline,
    loadContext: fixture.loadContext,
    programDataPath: fixture.stateRoot,
    configurationDirectoryPath: path.join(fixture.stateRoot, 'config'),
    metadataConfiguration: { UseFileCreationTimeForDateAdded: !sample.useResolveTime },
    configuration: fixture.configuration,
    refreshes,
    linkedChildReferences,
    metadataScanner,
    clock: () => fixture.now,
    onError: error => resolverErrors.push(error)
  });
  let mutationItem, beforeItem;
  if (sample.mutation) {
    await validation.validateChildren(loaded.parent, { collectionType: sample.collectionType, refreshChildMetadata: false });
    const Path = path.join(loaded.parent.Path, sample.mutationPath ?? sample.files[0]);
    const nativeType = sample.mutationType ? `MediaBrowser.Controller.Entities.${sample.mutationType}`
      : `MediaBrowser.Controller.Entities.${sample.expectedType === 'Movie' ? 'Movies.' : ''}${sample.expectedType}`;
    const existing = await creator.getItemById(loaded.getNewItemId(Path, nativeType));
    assert.ok(existing, 'Warm production validation must create the matching native identity.');
    mutationItem = existing;
    if (sample.warmNested) await validation.validateChildren(existing, {
      collectionType: sample.collectionType,
      refreshChildMetadata: false
    });
    for (const [field, value] of Object.entries(sample.mutation)) existing[field] = ['AdditionalParts', 'LocalAlternateVersions'].includes(field)
      ? value?.map(name => name == null || name === '' ? name : path.join(loaded.parent.Path, name)) ?? null : value;
    if (sample.imageCase) {
      const imagePath = path.join(internalImagePath(existing, loaded.metadataPath), 'poster.png');
      assert.ok(imagePath.startsWith(fixture.stateRoot + path.sep));
      await mkdir(path.dirname(imagePath), { recursive: true });
      if (sample.imageCase !== 'missing') {
        await writeFile(imagePath, Buffer.from('image control'));
        await utimes(imagePath, new Date('2025-01-03T04:05:06Z'), new Date('2025-01-03T04:05:06Z'));
      }
      existing.ImageInfos = [{ Path: imagePath, Type: 'Primary', DateModified: '2025-01-03T04:05:06.0000000Z',
        Width: sample.imageCase === 'current' ? 320 : 0, Height: sample.imageCase === 'current' ? 180 : 0,
        BlurHash: sample.imageCase === 'current' ? 'control-hash' : null }];
    }
    await creator.saveItems([existing]);
    if (sample.afterFiles) {
      for (const file of sample.files) if (!sample.afterFiles.includes(file)) await fixture.adapter.delete('/discovery/' + file);
      for (const file of sample.afterFiles) {
        await ensureFixtureDirectory(fixture, path.posix.dirname('/discovery-write/discovery/' + file));
        await fixture.adapter.write('/discovery/' + file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]),
          { modified: '2025-01-03T04:05:06.0000000Z' });
      }
    }
    if (sample.afterDirectories) for (const directory of sample.directories
      .filter(value => !sample.afterDirectories.includes(value))
      .toSorted((left, right) => right.split('/').length - left.split('/').length)) {
      await fixture.adapter.delete('/discovery/' + directory, { recursive: true });
    }
    if (sample.removeParentDirectory) await fixture.adapter.delete('/discovery', { recursive: true });
    if (sample.parentCycle) {
      await fixture.database.update('BaseItems', { Id: loaded.parent.Id }, { ParentId: existing.Id });
      loaded.parent.ParentId = existing.Id;
    }
    setFolderChildren(loaded.parent, [existing]); loaded.parent.UserData = [];
    const repositoryUpdate = updates.updateRepository.bind(updates);
    updates.updateRepository = (context, result, reason, options = {}) => repositoryUpdate(context, result, reason, { ...options,
      saverOperation: async () => {
        calls.push({ action: 'saver', id: guid(result.Item.Id), reason });
        if (sample.cancelFromSaver) controller.abort();
        if (sample.failSaver) throw Object.assign(new Error('Controlled metadata saver failure'), {
          code: 'invalid-operation'
        });
        return [];
      },
      persist: async (updated, result, options) => {
        calls.push({ action: 'save', items: [result.Item, ...options.newVersions].map(item => projectDirectoryItem(item, fixture, sample)),
          cancellable: Boolean(options.signal) });
        return persistMetadata(fixture.store, context, result, options);
      }
    });
    const projectImages = rows => rows.map(image => ({ path: projectStatePath(image.Path, fixture.stateRoot), type: image.Type,
      dateModified: dateText(image.DateModified), width: image.Width, height: image.Height,
      blurHash: image.Blurhash == null ? null : Buffer.from(image.Blurhash).toString('utf8') }));
    const updateImages = images.updateImages.bind(images);
    images.updateImages = (context, rows, options = {}) => {
      if (!Object.hasOwn(options, 'forceUpdate')) calls.push({ action: 'images', id: guid(context.item.Id), force: false });
      return updateImages(context, rows, { ...options, persistImages: async rows => {
        calls.push({ action: 'save-images', id: guid(context.item.Id), images: projectImages(rows), cancellable: Boolean(options.signal) });
        return options.persistImages(rows);
      } });
    };
    images.processor.getImageSize = async (bytes, imagePath, options) => {
      assert.equal(options.signal, undefined, 'Native image work must not inherit the scan token.');
      calls.push({ action: 'image-size', path: projectStatePath(imagePath, fixture.stateRoot) });
      if (sample.cancelFromImageSize) controller.abort();
      if (sample.imageCase === 'dimensions-failure') throw new Error('Controlled image dimensions failure');
      return { Width: 320, Height: 180 };
    };
    images.processor.getImageBlurHash = async (bytes, imagePath, size, options) => {
      assert.equal(options.signal, undefined);
      calls.push({ action: 'image-blur', path: projectStatePath(imagePath, fixture.stateRoot), width: size.Width, height: size.Height });
      if (sample.imageCase === 'blur-failure') throw new Error('Controlled image blur failure');
      return 'control-hash';
    };
    if (sample.failUpdate || sample.failImageInsert) {
      const table = sample.failImageInsert ? 'BaseItemImageInfos' : 'BaseItems', action = sample.failImageInsert ? 'INSERT' : 'UPDATE';
      await fixture.database.client.query("CREATE FUNCTION validation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled existing validation failure'; END $$");
      await fixture.database.client.query(`CREATE TRIGGER validation_failure BEFORE ${action} ON "${table}" FOR EACH ROW EXECUTE FUNCTION validation_failure()`);
    }
    if (sample.failDelete || sample.failCreateAfterDelete) {
      const action = sample.failDelete ? 'DELETE' : 'INSERT';
      await fixture.database.client.query("CREATE FUNCTION reconciliation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled child reconciliation failure'; END $$");
      await fixture.database.client.query(`CREATE TRIGGER reconciliation_failure BEFORE ${action} ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION reconciliation_failure()`);
    }
    if (sample.failSavedUpdatePath) {
      const failedPath = nativeTextBytes(path.join(loaded.parent.Path, sample.failSavedUpdatePath)).toString('hex');
      const savedDate = nativeTextBytes('0001-01-01T00:00:00.0000000Z').toString('hex');
      const sql = nativeTextSql(fixture.database.schemaName);
      await fixture.database.client.query("CREATE FUNCTION saved_version_update_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled saved version update failure'; END $$");
      await fixture.database.client.query(`CREATE TRIGGER saved_version_update_failure BEFORE UPDATE ON "BaseItems" FOR EACH ROW
        WHEN (NEW."Path" = decode('${failedPath}','hex') AND
          ${sql.jsonTextBytes(sql.safeItemData('NEW."Type"','NEW."Data"'), "'DateLastSaved'")} <> decode('${savedDate}','hex'))
        EXECUTE FUNCTION saved_version_update_failure()`);
    }
    beforeItem = projectDirectoryItem(existing, fixture, sample);
    calls.length = 0;
  }
  if (sample.cancelled) controller.abort();
  let exception = null;
  let resolved = [];
  traversalActive = true;
  value.activate();
  try {
    if (sample.resolveOnly) resolved = await resolveDirectoryVideo(value, sample);
    else await validation.validateChildren(loaded.parent, {
      collectionType: sample.afterCollectionType ?? sample.collectionType,
      signal: sample.cancelled || sample.cancellable ? controller.signal : undefined,
      recursive: sample.recursive ?? false,
      refreshChildMetadata: sample.refreshChildMetadata ?? false,
      allowRemoveRoot: sample.allowRemoveRoot ?? false,
      reportProgress
    });
    if (sample.repeatValidation) await validation.validateChildren(loaded.parent, {
      collectionType: sample.collectionType,
      recursive: sample.recursive ?? false,
      refreshChildMetadata: sample.refreshChildMetadata ?? false,
      allowRemoveRoot: sample.allowRemoveRoot ?? false,
      reportProgress
    });
  } catch (error) {
    if ((sample.cancelled || sample.cancelFromImageSize || sample.cancelFromCleanup || sample.cancelFromSaver)
      && error === controller.signal.reason) exception = 'OperationCanceledException';
    else if (sample.failSaver) {
      assert.equal(error.code, 'invalid-operation');
      assert.match(error.message, /Controlled metadata saver failure/u);
      exception = 'InvalidOperationException';
    }
    else if (sample.expectException === 'InvalidOperationException') {
      assert.equal(error.code, 'invalid-operation');
      assert.match(error.message, /Recursive datastructure/u);
      exception = 'InvalidOperationException';
    }
    else if (sample.failSavedUpdatePath) {
      assert.match(error.message, /Controlled saved version update failure/u);
      assert.ok(databaseFault(error, dialect));
      exception = 'DbUpdateException';
    }
    else if (sample.name.endsWith('-replace-primary') && !sample.failUpdate && !sample.failDelete) {
      assert.match(error.message, /FOREIGN KEY constraint failed|violates foreign key constraint/u);
      assert.equal(error.code, '23503');
      assert.equal(calls.at(-1)?.action, 'save', 'The frozen FK failure occurs at SaveItems.');
      exception = 'DbUpdateException';
    }
    else if (sample.failDelete || sample.failCreateAfterDelete) {
      assert.match(error.message, /Controlled child reconciliation failure/u);
      assert.ok(databaseFault(error, dialect));
      exception = sample.expectException ?? 'DbUpdateException';
    }
    else if (sample.failUpdate || sample.failImageInsert) {
      assert.match(error.message, /Controlled existing validation failure/u);
      assert.ok(databaseFault(error, dialect));
      exception = 'DbUpdateException';
    }
    else if (sample.failInsert || sample.failInsertAlternate || sample.failLinks) {
      assert.match(error.message, /Controlled creation failure/u);
      assert.ok(databaseFault(error, dialect));
      exception = 'DbUpdateException';
    } else throw error;
  }

  const actual = await projectDirectoryResolution(value, sample, resolved, exception);
  if (!sample.resolveOnly) actual.resolved = null;
  for (const row of actual.rows) {
    const expectedRow = expected.rows.find(value => value.id === row.id);
    if (expectedRow?.dateCreated === '$UTC_RESOLVE') {
      assert.equal(row.dateCreated, fixture.now, 'Stored Folder resolve UTC must use the supplied candidate clock.');
      row.dateCreated = '$UTC_RESOLVE';
    }
  }
  actual.ancestors = (await fixture.database.rows('AncestorIds')).map(row => ({
    itemId: guid(row.ItemId), parentItemId: guid(row.ParentItemId)
  })).sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.parentItemId, right.parentItemId));
  actual.providers = (await fixture.database.rows('BaseItemProviders')).map(row => ({
    itemId: guid(row.ItemId), providerId: row.ProviderId, providerValue: row.ProviderValue
  })).sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.providerId, right.providerId));
  const savedIds = sample.mutation ? expected.createdLookup.map(value => value.id)
    : expected.calls.find(call => call.action === 'save')?.items.map(item => item.id) ?? [];
  actual.columns = await completeColumns(fixture, savedIds.map(Id => ({ Id })), sample);
  actual.createdLookup = [];
  for (const expectedLookup of expected.createdLookup) {
    const item = await creator.getItemById(expectedLookup.id);
    actual.createdLookup.push({ id: expectedLookup.id, item: item && projectDirectoryItem(item, fixture, sample) });
  }
  if (sample.mutation) {
    const imageRows = await fixture.database.rows('BaseItemImageInfos');
    assert.equal(new Set(imageRows.map(row => idKey(row.Id))).size, imageRows.length);
    assert.ok(imageRows.every(row => /^[a-f0-9]{32}$/u.test(idKey(row.Id)) && !/^0+$/u.test(idKey(row.Id))));
    actual.images = imageRows.map(row => ({ id: `$IMAGE_GUID:${guid(row.ItemId)}:${row.ImageType}`,
      itemId: guid(row.ItemId), imageType: row.ImageType, path: projectStatePath(row.Path, fixture.stateRoot),
      dateModified: dateText(row.DateModified),
      width: row.Width, height: row.Height, blurhash: row.Blurhash == null ? null : Buffer.from(row.Blurhash).toString('base64') }))
      .sort((left, right) => ordinal(left.itemId, right.itemId) || left.imageType - right.imageType);
  }
  if (reconciliation) {
    actual.beforeItem = beforeItem;
    const lookup = await creator.getItemById(mutationItem.Id);
    actual.mutationLookup = lookup && projectDirectoryItem(lookup, fixture, sample);
    actual.mutatedLive = projectDirectoryItem(mutationItem, fixture, sample);
  }
  assert.deepEqual(actual, expected);
  assert.equal(resolverErrors.length, sample.resolverFailure
    || (sample.recursive && (sample.failDirectory || sample.cancelFromSaver)) ? 1 : 0);
  return { fixture, validation, loaded, creator };
}

const databaseFault = error => error.code === 'P0001';
