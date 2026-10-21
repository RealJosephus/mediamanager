import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';

const owners = new WeakMap();

// Assemble the same concrete readers as runtime. This fixture owns only the
// relation runtime it creates; a supplied relation runtime stays caller-owned.
export async function attachLibraryNavigation(library) {
  if (owners.has(library) || library.itemCreation || !library.store?.database) {
    throw new TypeError('Navigation fixture requires an unassembled PostgreSQL library.');
  }
  const supplied = library.options.linkedChildren;
  const linkedChildren = supplied ?? new PostgresLinkedChildrenStore({ database: library.store.database });
  let itemCreation, closing;
  const owner = Object.freeze({ close: () => closing ??= (async () => {
    const errors = [];
    for (const close of [() => library.close(), () => itemCreation?.close(),
      () => linkedChildren.flushReleases(), ...(!supplied ? [() => linkedChildren.close()] : [])]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Library navigation fixture owners failed to close.');
  })() });
  owners.set(library, owner);
  try {
    if (!supplied) await linkedChildren.initialize();
    library.options.linkedChildren = linkedChildren;
    const loadContext = createMetadataContextLoader({ store: library.store, library, linkedChildren,
      fileSystem: library.options.fileSystem, configuration: library.options.configuration });
    itemCreation = library.itemCreation = new ItemCreationService({ store: library.store, library, linkedChildren, loadContext });
    return owner;
  } catch (error) {
    try { await owner.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}

export function closeLibraryNavigation(library) {
  if (library == null) return Promise.resolve();
  const owner = owners.get(library);
  if (!owner) throw new TypeError('The library has no navigation fixture owner.');
  return owner.close();
}
