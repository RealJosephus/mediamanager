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
assert.equal(raw.actualFrozenEpisodeSeasonGetters, true); assert.equal(raw.actualFrozenApplyOrderSqlTranslation, true);
assert.equal(raw.dependenciesControlled, true); assert.equal(raw.databaseOpened, false);
assert.equal(raw.sharedPostgresUsed, false); assert.equal(raw.portOpened, false);
assert.equal(raw.getters.length, 12); assert.equal(raw.sql.length, 7);
for (const entry of raw.getters) {
  assert.equal(entry.userDataKeys.at(-1), entry.Id);
  if (entry.mode === 'missing-explicit' || entry.mode === 'wrong-type-explicit' || entry.mode === 'empty-unrelated-chain') {
    assert.equal(entry.actualSeriesId, null); assert.deepEqual(entry.userDataKeys, [entry.Id]);
  }
}
assert.equal(raw.ignoredAlias.SeriesId, '00000000-0000-0000-0000-000000000000');
assert.equal(raw.ignoredAlias.actualSeriesId, raw.parentItems[0].Id);
const sourceBytes = await readFile(path.join(source, 'Program.cs'));
assert.deepEqual(sourceBytes, await readFile(path.join(fixture, 'Oracle.cs')));
const bindings = [];
async function bind(relative) {
  const bytes = await readFile(validationPath(path.join(repo, relative)));
  bindings.push({ path: relative.replaceAll('\\', '/'), sha256: hash(bytes), bytes: bytes.length });
}
for (const name of ['Program.cs', 'Oracle.csproj', 'stdout.txt', 'exit.json']) await bind(path.relative(repo, path.join(source, name)));
const root = '.agent-docs/baselines/jellyfin-current/source/';
for (const name of ['MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs',
  'MediaBrowser.Controller/Entities/TV/Episode.cs', 'MediaBrowser.Controller/Entities/TV/Season.cs',
  'MediaBrowser.Controller/Entities/TV/Series.cs', 'Jellyfin.Server.Implementations/Item/OrderMapper.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/SqliteDatabaseProvider.cs']) await bind(root + name);
for (const name of ['MediaBrowser.Controller', 'MediaBrowser.Model', 'Jellyfin.Server.Implementations',
  'Jellyfin.Database.Implementations', 'Jellyfin.Database.Providers.Sqlite', 'Jellyfin.Extensions', 'Jellyfin.Data']) {
  await bind(root + `Jellyfin.Server/bin/Release/net10.0/${name}.dll`);
  assert.equal(bindings.at(-1).sha256, hash(await readFile(path.join(source, `bin/Release/net10.0/${name}.dll`))));
  assert.equal(raw.loadedAssemblies.find(entry => entry.name === name).sha256, bindings.at(-1).sha256);
}
await bind(root + 'Jellyfin.Server/bin/Release/net10.0/runtimes/win-x64/native/e_sqlite3.dll');
assert.equal(bindings.at(-1).sha256, hash(await readFile(path.join(source, 'bin/Release/net10.0/e_sqlite3.dll'))));
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBindings: bindings,
  oracleSourceSha256: hash(sourceBytes), nativeProcessExit: 0, raw,
  limitations: raw.sourceBoundary + ' Video.RecordingsManager is an empty controlled interface; recordings branches are outside this matrix.' }, null, 2) + '\n');
await writeFile(path.join(fixture, 'native.json'), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: hash(bytes), bindings: bindings.length }));
