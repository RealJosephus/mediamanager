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
const summary = JSON.parse(await readFile(path.join(source, 'summary.json')));
assert.equal(summary.nativeProcessExit, 0); assert.equal(summary.verified, true);
assert.equal(raw.actualFrozenFolderMethods, true); assert.equal(raw.actualFrozenCollectionFolder, true);
assert.equal(raw.output.length, 4); assert.equal(raw.databaseOpened, false);
for (const entry of raw.output) {
  assert.equal(entry.LinkedChildrenLoaded, true); assert.deepEqual(entry.cachedChildren, []);
  assert.equal(entry.withoutCount, 0); assert.equal(entry.withCount, entry.links.length);
  assert.equal(entry.TotalRecordCount, entry.withLinks.length); assert.equal(entry.childCount, entry.withLinks.length);
  assert.deepEqual(entry.withLinks, entry.itemIds); assert.equal(entry.itemIds.length, new Set(entry.links.map(link => link.ItemId)).size);
  assert.deepEqual(entry.anonymousItemIds, []); assert.equal(entry.anonymousTotalRecordCount, 0);
}
assert.deepEqual(raw.output[0].physicalFolderIds, []); assert.deepEqual(raw.output[2].physicalFolderIds, []);
assert.deepEqual(raw.output[2].links.map(link => link.Type), [0, 1, 2]);
assert.equal(raw.output[3].childCount, 2);
assert.equal(new Set(raw.output[3].sources.map(item => item.PresentationUniqueKey)).size, 1);
assert.equal(await readFile(path.join(source, 'Program.cs'), 'utf8'), await readFile(path.join(fixture, 'Oracle.cs'), 'utf8'));
const bindings = [];
async function bind(relative) {
  const bytes = await readFile(validationPath(path.join(repo, relative)));
  bindings.push({ path: relative.replaceAll('\\', '/'), sha256: hash(bytes), bytes: bytes.length });
}
for (const name of ['Program.cs', 'Oracle.csproj', 'stdout.txt', 'summary.json']) await bind(path.relative(repo, path.join(source, name)));
const root = '.test-input/baselines/jellyfin-current/source/';
for (const name of ['MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', 'MediaBrowser.Controller/Entities/Video.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/User.cs',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs']) await bind(root + name);
for (const name of ['MediaBrowser.Controller', 'MediaBrowser.Model', 'Jellyfin.Server.Implementations',
  'Jellyfin.Database.Implementations', 'Jellyfin.Extensions', 'Emby.Server.Implementations']) {
  await bind(root + `Jellyfin.Server/bin/Release/net10.0/${name}.dll`);
  assert.equal(bindings.at(-1).sha256, hash(await readFile(path.join(source, `bin/Release/net10.0/${name}.dll`))));
}
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBindings: bindings,
  oracleSourceSha256: hash(await readFile(path.join(fixture, 'Oracle.cs'))), nativeProcessExit: 0, raw,
  limitations: 'Real frozen Folder/CollectionFolder GetChildren/GetItems/GetChildCount and explicit entity field readback. Library lookup, configuration, user-data and recordings interfaces are controlled, and source admission is controlled. Full DtoService, native SQL repository and HTTP controller were not invoked. The regression covers CollectionFolder fallback and controls for cached Children, anonymous GetItems and plain Folder batch; public Items linked-child behavior remains a separate unaccepted difference.'
}, null, 2) + '\n');
await writeFile(path.join(fixture, 'native.json'), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: hash(bytes), bindings: bindings.length }));
