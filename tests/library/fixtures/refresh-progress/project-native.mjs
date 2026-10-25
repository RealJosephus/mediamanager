import { validationPath } from '../../../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.resolve(process.argv[2]), fixture = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixture, '../../../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = JSON.parse(await readFile(path.join(source, 'stdout.txt')));
const exit = JSON.parse(await readFile(path.join(source, 'exit.json')));
assert.deepEqual(exit, { buildExit: 0, nativeProcessExit: 0 });
assert.equal(raw.actualFrozenLibraryManagerMembership, true);
assert.equal(raw.actualFrozenCollectionRefreshProgress, true); assert.equal(raw.actualFrozenNotifier, true);
assert.equal(raw.dependenciesControlled, true); assert.equal(raw.actualWebSocketTransportInvoked, false);
assert.equal(raw.databaseOpened, false); assert.equal(raw.phaseAcceptance, false);
const id = index => `d1000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
assert.deepEqual(raw.windowsCollectionIds, [id(4), id(9)]);
assert.deepEqual(raw.posixCollectionIds, [id(8)]);
assert.deepEqual(raw.rootChildIds, [4, 7, 8, 9, 10, 12].map(id));
assert.deepEqual(raw.ignoredAlias, { PhysicalLocationsList: [], PhysicalLocations: [], PhysicalFolderIds: [] });
assert.equal(raw.output.length, 6);
assert.deepEqual(raw.output.map(entry => entry.getters.find(folder => folder.Id === id(4)).progress), [null, null, null, null, null, null]);
assert.deepEqual(raw.output.map(entry => entry.getters.find(folder => folder.Id === id(9)).progress), [0, 40, 40, 20, 0, null]);
assert.deepEqual(raw.output.map(entry => entry.messages.length), [3, 3, 3, 2, 3, 2]);
assert.equal(raw.output[2].phase, 'own-active-collection'); assert.equal(raw.output[2].own, 66);
assert.equal(raw.output[2].active.find(entry => entry.id === id(4)).progress, 66);
for (const entry of raw.output) {
  assert.deepEqual(entry.messages[0], { messageType: 'RefreshProgress', data: {
    ItemId: entry.itemId.replaceAll('-', ''), Progress: String(entry.progress) } });
  assert.equal(entry.isRoot, false); assert.equal(entry.isTopParent, true);
  assert.deepEqual(entry.ownProducerMessages, []);
}
const sourceBytes = await readFile(path.join(source, 'Program.cs'));
assert.deepEqual(sourceBytes, await readFile(path.join(fixture, 'Oracle.cs')));
const bindings = [];
async function bind(relative) {
  const bytes = await readFile(validationPath(path.join(repo, relative)));
  bindings.push({ path: relative.replaceAll('\\', '/'), sha256: hash(bytes), bytes: bytes.length });
}
for (const name of ['Program.cs', 'Oracle.csproj', 'stdout.txt', 'exit.json']) await bind(path.relative(repo, path.join(source, name)));
const root = '.test-input/baselines/jellyfin-current/source/';
for (const name of ['MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/EntryPoints/LibraryChangedNotifier.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs']) await bind(root + name);
for (const name of ['MediaBrowser.Controller', 'MediaBrowser.Model', 'Jellyfin.Server.Implementations',
  'Jellyfin.Database.Implementations', 'Jellyfin.Extensions', 'Emby.Server.Implementations']) {
  await bind(root + `Jellyfin.Server/bin/Release/net10.0/${name}.dll`);
  assert.equal(bindings.at(-1).sha256, hash(await readFile(path.join(source, `bin/Release/net10.0/${name}.dll`))));
}
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBindings: bindings,
  oracleSourceSha256: hash(sourceBytes), nativeProcessExit: 0, raw,
  limitations: raw.sourceBoundary }, null, 2) + '\n');
await writeFile(path.join(fixture, 'native.json'), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: hash(bytes), bindings: bindings.length }));
