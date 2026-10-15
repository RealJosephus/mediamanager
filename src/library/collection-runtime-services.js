import { CollectionService } from './collection-service.js';
import { CollectionPostScanTask } from './collection-post-scan-task.js';
import { createPostgresCollectionMaintenanceSource } from './postgres-collection-maintenance.js';

/** Construct after the live item/metadata/configuration owners exist. Runtime
 * installs the task immediately after CollectionPosterVerify before triggers
 * start, and drains both tasks and collection admission before relation close. */
export function createCollectionRuntimeServices({ store, library, itemCreation, loadContext,
  updates, metadata, host, libraryConfiguration, monitor, programDataPath, dataPath,
  localization, fileSystem, linkedChildren, logger, onError }) {
  const collections = new CollectionService({ store, library, itemCreation, loadContext, updates,
    metadata, host, libraryConfiguration, monitor, programDataPath, dataPath, localization, fileSystem, linkedChildren, onError });
  const source = createPostgresCollectionMaintenanceSource({ host, getLibraryOptions: async root => {
    return itemCreation.withItem(root.Id, item => {
      if (!item) throw new Error('The selected collection root no longer exists.');
      return loadContext.withContext(root.Id, { draft: item, includeChildren: false }, loaded => loaded.libraryOptions);
    });
  } });
  const collectionPostScanTask = new CollectionPostScanTask({ store, source, collections, logger });
  return { collections, collectionPostScanTask };
}
