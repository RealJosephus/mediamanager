import { testFileSystem } from '../storage/plugin-files.js';
import { deletePersistedItems } from '../../src/library/item-persistence.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createTmdbTestServices({ store, serverId = 'tmdb-cleanup', vfs = {}, identityMap = {}, configuration = {} }) {
  const linkedChildren = new PostgresLinkedChildrenStore({ database: store.database });
  await linkedChildren.initialize();
  const programDataPath = await mkdtemp(path.join(os.tmpdir(), 'tmdb-cleanup-state-'));
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId, configuration, programDataPath });
  const original = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, vfs, identityMap, configuration });
  const contexts = new Set(), hosts = new Set();
  const loadContext = Object.assign(async (...args) => {
    const loaded = await original(...args); contexts.add(loaded); return loaded;
  }, original);
  const itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = itemCreation;
  return { store, library, linkedChildren, itemCreation, loadContext, registerHost(host) { hosts.add(host); },
    async close() {
      for (const host of hosts) await host.close();
      for (const loaded of contexts) await loaded.dispose();
      await itemCreation.close(); await library.close();
      await linkedChildren.flushReleases(); await linkedChildren.close();
      await rm(programDataPath, { recursive: true, force: true });
    }
  };
}

export function persistedTmdbCleanupLifecycle({ store, library, linkedChildren, loadContext, now }) {
  return {
    async load(series) {
      const loaded = await loadContext(series.Id, { includeChildren: false });
      const factory = createMetadataChildren({ store, library, linkedChildren,
        configuration: loaded.globalOptions, libraryOptions: loaded.libraryOptions });
      let children;
      return { recursive: async () => children ??= await factory.recursive(loaded.item),
        async close() { try { await children?.close(); } finally { await loaded.dispose(); } }
      };
    },
    remove: item => deletePersistedItems(store, [item.Id], { now }),
  };
}
