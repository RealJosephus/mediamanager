import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { StorageError } from '../../src/storage/errors.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

// Shared neutral controls and production runtime assembly. The resolution
// fixture's current capture records designated Native execution evidence.
export const parentId = '15000000-0000-0000-0000-000000000099';
export const subjectId = index => `15000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
export const created = '2026-10-09T01:02:03.0000000Z', modified = '2026-10-09T02:03:04.0000000Z';
export const stateRoot = 'Z:\\CollectionResolverFixture';

export function sampleContext(sample, sampleRoot = stateRoot) {
  const media = path.win32.join(sampleRoot, 'media');
  const entries = new Map();
  const add = (relative, kind) => {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) entries.set(parts.slice(0, index).join('/'), 'directory');
    entries.set(relative, kind);
  };
  for (const name of sample.directories ?? []) add(name, 'directory');
  for (const name of sample.files ?? []) add(name, 'file');
  const candidates = [...entries].map(([relative, kind]) => ({
    identityPath: path.win32.join(media, ...relative.split('/')),
    accessPath: '/fixture/collection-resolver/' + relative,
    entry: { name: relative.split('/').at(-1), kind, size: kind === 'file' ? 20n : null, created, modified }
  }));
  const target = candidates.find(candidate => candidate.identityPath === path.win32.join(media, ...sample.target.split('/')));
  assert.ok(target, `${sample.name}: neutral input must create its target`);
  const children = candidates.filter(candidate => path.win32.dirname(candidate.identityPath) === target.identityPath);
  if (sample.trailingSeparator) target.identityPath += '\\';
  if (sample.enumerationError) target.identityPath = path.win32.join(media, 'absent-native-directory');
  const parent = newNativeItemEntity(sample.parentKind === 'PlaylistsFolder'
    ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder' : 'MediaBrowser.Controller.Entities.Folder');
  Object.assign(parent, { Id: parentId, Name: 'Physical root', Path: media });
  return {
    parent, candidate: target, collectionContext: { collectionType: sample.collectionType ?? null },
    deletionSafe: true,
    peekDirectory: async () => {
      if (sample.enumerationError) throw new StorageError('not-found', 'Controlled missing directory.');
      return { listing: { deletionSafe: true }, candidates: children };
    }
  };
}

export async function runtimeFixture(t, contentTypes = []) {
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'Real PostgreSQL is required for production assembly.');
  const fixture = await setupChildrenFixture(t);
  // Runtime owns its connection pool; the fixture's independent pool retains
  // ownership of the exact random schemas used for teardown.
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema: fixture.database.schemaName });
  const runtime = await createTestRuntime({ database, programDataPath: fixture.stateRoot,
    vfs: fixture.vfs, identityMap: fixture.identityMap,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: fixture.storage, vfs: fixture.vfs,
      identityMap: fixture.identityMap, identityRoots: [fixture.stateRoot] }),
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', ContentTypes: contentTypes },
    serverId: 'special-resolver-runtime' });
  t.after(() => runtime.close());
  return { fixture, runtime };
}
