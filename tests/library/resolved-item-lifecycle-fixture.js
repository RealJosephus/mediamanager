import { testFileSystem } from '../storage/plugin-files.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';

export async function createResolvedItemLifecycleFixture({ store, library, linkedChildren, spoolRoot, vfs, identityMap, ignoreRule, configuration = {}, now,
  logger = { error() {} } }) {
  const ownedLinks=!linkedChildren;
  if(ownedLinks){linkedChildren=new PostgresLinkedChildrenStore({database:store.database});await linkedChildren.initialize();}
  library.options.linkedChildren=linkedChildren;
  const processor = new ImageProcessor({fileSystem: testFileSystem,  logger });
  const images = new MetadataImages({ processor, logger });
  const registry = new MetadataRegistry();
  const base=createMetadataContextLoader({fileSystem: testFileSystem, store,library,linkedChildren,spoolRoot,vfs,identityMap,ignoreRule,configuration}),contexts=new Set();
  const loadContext=Object.assign(async(...args)=>{const loaded=await base(...args),dispose=loaded.dispose.bind(loaded);contexts.add(loaded);loaded.dispose=async()=>{try{await dispose();}finally{contexts.delete(loaded);}};return loaded;},base);
  loadContext.withContext=async(reference,options,operation)=>{const loaded=await loadContext(reference,options);try{return await operation(loaded);}finally{await loaded.dispose();}};
  const updates = new MetadataUpdateHost({ registry, store, images, library, logger, ...(now ? { now } : {}) });
  return {
    linkedChildren,
    lifecycle: new ResolvedItemLifecycleHost({ store, loadContext, updates, images }),
    loadContext,
    updates,
    images,
    async close() {
      for(const context of contexts)await context.dispose();
      await images.close();
      await processor.close();
      if(ownedLinks){await library.itemCreation?.close();await library.close();await linkedChildren.flushReleases();await linkedChildren.close();}
    }
  };
}

export const inertResolvedItemLifecycle = Object.freeze({
  async apply() {
    return Object.freeze({ branch: 'images', changed: false, imagesChanged: false, saves: Object.freeze([]) });
  }
});
