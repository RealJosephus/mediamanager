import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { openConfiguredPluginHost } from '../plugins/configuration-host.js';

export async function openStorageFixture(t, filename, options = {}) {
  const directory = await fs.mkdtemp(path.join(path.dirname(filename), 'plugin-owner-'));
  const plugins = await openConfiguredPluginHost({ directory });
  let storage, storageClose, closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const operation of [() => storageClose?.(), () => plugins.close()]) try { await operation(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Storage fixture owners could not close.', { cause: failures[0] });
  })();
  try {
    storage = await createConfiguredStorage(filename, { ...options, plugins });
    storageClose = storage.close.bind(storage);
    storage.close = close;
    t.after(close);
    return storage;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Storage fixture initialization and cleanup failed.', { cause: error }); }
    throw error;
  }
}
