import { testFileSystem } from '../storage/plugin-files.js';
import { mkdir } from 'node:fs/promises';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';

// A real state-only lifecycle, not the removed direct Playlist SQL fallback.
export function attachStateDeletion({ store, library, linkedChildren, spoolRoot }) {
  const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot });
  const itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren });
  const updates = new MetadataUpdateHost({ store, library, registry: new MetadataRegistry() });
  const externalData = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: library.options.dataPath,
    metadataPath: library.options.metadataPath ?? library.options.programDataPath + '/metadata' });
  const linkedChildReferences = new LinkedChildReferenceService({ store, itemCreation, loadContext, updates });
  library.itemCreation = itemCreation;
  library.itemDeletion = new ItemDeletionService({ store, library, loadContext, itemCreation, updates, externalData, linkedChildReferences });
  return itemCreation;
}

// Each isolated test owns an actual independent SQL relation pool and spool.
export async function createStateRelations(database, spoolRoot) {
  await mkdir(spoolRoot, { recursive: true });
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  try { await linkedChildren.initialize(); return linkedChildren; }
  catch (error) {
    try { await linkedChildren.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'SQL test relations failed to initialize and close.', { cause: error }); }
    throw error;
  }
}

export async function closeStateDeletion({ playlists, itemCreation, library, linkedChildren }) {
  const errors = [];
  for (const close of [() => playlists?.close(), () => library?.close(),
    () => itemCreation?.close(), () => linkedChildren?.flushReleases(), () => linkedChildren?.close()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'SQL test lifecycle cleanup failed.');
}
