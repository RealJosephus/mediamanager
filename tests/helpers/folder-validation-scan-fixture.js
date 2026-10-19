import path from 'node:path';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';

const metadataNotConfigured = async () => {
  throw new Error('This structural validation fixture requires refreshChildMetadata: false or a real metadata scanner.');
};

/** Assemble the production services; callers invoke validateChildren directly. */
export function createFolderValidationScanFixture({
  store, library, vfs, identityMap, ignoreRule, resolverPipeline, programDataPath,
  configuration = library.options.configuration ?? {}, lifecycleFixture,
  loadContext = lifecycleFixture.loadContext,
  resolvedItemLifecycle = lifecycleFixture.lifecycle,
  updates = lifecycleFixture.updates,
  itemCreation, itemDeletion, linkedChildReferences, externalData,
  metadataScanner = { refreshAccessibleChildren: metadataNotConfigured, refreshContainer: metadataNotConfigured },
  refreshes = new ProviderRefreshService(), clock, onError = () => {}
}) {
  const ownsItems = !itemCreation;
  itemCreation ??= new ItemCreationService({ store, library, loadContext, linkedChildren: loadContext.linkedChildren });
  library.itemCreation = itemCreation;
  linkedChildReferences ??= new LinkedChildReferenceService({ store, itemCreation, loadContext, updates });
  externalData ??= new ExternalDataManager({ store, vfs, identityMap, fileSystem: library.options.fileSystem });
  itemDeletion ??= new ItemDeletionService({ store, library, loadContext, itemCreation, updates, externalData,
    linkedChildReferences, vfs, ...(clock ? { now: clock } : {}) });
  library.itemDeletion = itemDeletion;
  const scheduler = new LibraryTaskScheduler({ configuration, onError,
    runWorker: operation => store.runDetached(() => loadContext.withDetachedScope(operation)) });
  const pathApi = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(programDataPath) ? path.win32 : path.posix;
  const validation = new FolderValidationService({ store, library, itemCreation, resolvedItemLifecycle,
    vfs, identityMap, ignoreRule, resolverPipeline, loadContext, programDataPath,
    configurationDirectoryPath: pathApi.join(programDataPath, 'config'), configuration, refreshes,
    linkedChildReferences, metadataScanner, scheduler, onError, ...(clock ? { clock } : {}) });
  library.folderValidation = validation;
  return {
    validation, itemCreation, itemDeletion, linkedChildReferences, scheduler,
    async close() {
      try { await scheduler.close(); }
      finally { if (ownsItems) await itemCreation.close(); }
    }
  };
}
