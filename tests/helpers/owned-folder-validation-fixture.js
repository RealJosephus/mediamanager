import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { createFolderValidationScanFixture } from './folder-validation-scan-fixture.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Media identities remain the recorded Windows paths. Instance metadata is
// real, isolated host storage, reached through the fixture's local plugin.
export async function ownedStatePaths(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owned-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, 'metadata'), dataPath = path.join(root, 'data');
  await mkdir(metadataPath); await mkdir(dataPath);
  return { metadataPath, dataPath };
}

// These media bytes exercise owned-item discovery and persistence, not probe.
export const ownedRefreshOptions = Object.freeze({
  recursive: true, MetadataRefreshMode: 'None', ImageRefreshMode: 'None'
});

// A real first-refresh save may repeat while DateLastRefreshed is still unset.
// Keep every persisted field except that operation's wall-clock save timestamp.
export function withoutSaveTime({ DateLastSaved, ...row }) {
  if (row.Data != null) {
    const { DateLastSaved: jsonSaveTime, ...data } = JSON.parse(row.Data);
    row.Data = JSON.stringify(data);
  }
  return row;
}

export function createOwnedFolderValidationFixture(options) {
  const { lifecycleFixture, store, library, vfs } = options;
  const errors = [];
  const logger = { error(error) { errors.push(error); } };
  const fixture = createFolderValidationScanFixture({ ...options, onError: error => errors.push(error) });
  const metadata = new MetadataRefreshHost({ store, vfs, registry: lifecycleFixture.updates.registry,
    linkedChildren: lifecycleFixture.linkedChildren, loadContext: lifecycleFixture.loadContext,
    updates: lifecycleFixture.updates, images: lifecycleFixture.images, logger,
    ...(options.externalData ? { externalData: options.externalData } : {}) });
  // Theme audio uses the real metadata lifecycle; no probe is installed.
  metadata.supportedItemTypes = [...metadata.supportedItemTypes, 'Audio'];
  fixture.validation.metadataScanner = new LibraryMetadataScanService({ library, metadata,
    configuration: options.configuration, scheduler: fixture.scheduler, logger });
  return { ...fixture, metadata, errors,
    async close() {
      metadata.cancel();
      try { await fixture.close(); } finally { await metadata.close(); }
    }
  };
}
