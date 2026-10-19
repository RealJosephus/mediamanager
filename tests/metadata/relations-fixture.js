import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';

export async function openMetadataRelations(database, spoolRoot) {
  await mkdir(spoolRoot, { recursive: true });
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  try { await linkedChildren.initialize(); return linkedChildren; }
  catch (error) {
    try { await linkedChildren.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Metadata test relation initialization failed.', { cause: error }); }
    throw error;
  }
}

export function trackMetadataContexts(loader, registry = []) {
  const contexts = new Set();
  const tracked = Object.assign(async (...args) => {
    const loaded = await loader(...args), dispose = loaded.dispose.bind(loaded);
    contexts.add(loaded);
    loaded.dispose = async () => { try { await dispose(); } finally { contexts.delete(loaded); } };
    return loaded;
  }, loader);
  tracked.withContext = async (reference, options, operation) => {
    const loaded = await tracked(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  tracked.close = async () => {
    const errors = [];
    for (const loaded of [...contexts]) try { await loaded.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Metadata test contexts failed to close.');
  };
  registry.push(tracked); return tracked;
}

export function attachMetadataItemCreation({ store, library, linkedChildren, loadContext }) {
  const itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = itemCreation; return itemCreation;
}

export async function closeMetadataFixture({ before = [], contexts = [], library, itemCreation, linkedChildren, after = [] }) {
  const errors = [];
  for (const close of [...before, ...contexts.map(loader => () => loader.close()), () => library?.close(),
    () => itemCreation?.close(), () => linkedChildren?.flushReleases(), () => linkedChildren?.close(), ...after]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Metadata test lifecycle cleanup failed.');
}

export async function removeMetadataTestRoot(directory, prefix) {
  const target = path.resolve(directory);
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith(prefix)) throw new Error('Metadata test root escaped its owned temporary namespace.');
  await rm(target, { recursive: true, force: true });
}
