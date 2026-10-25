import { validationPath } from '../../../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(process.argv[2]);
const fixture = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixture, '../../../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stdout = await readFile(path.join(source, 'stdout.txt'));
const result = JSON.parse(stdout);
const processResult = JSON.parse(await readFile(path.join(source, 'process.json')));
assert.equal(processResult.nativeProcessExit, 0);
assert.equal(result.actualFrozenBaseItemMapper, true);
assert.equal(result.actualFrozenDisplayParentGetter, true);
assert.equal(result.actualFrozenNullableGuidSerializer, true);
assert.equal(result.actualFullDtoServiceInvoked, false);
assert.equal(result.result.length, 16);
assert.equal(await readFile(path.join(fixture, 'Oracle.cs'), 'utf8'), await readFile(path.join(source, 'Program.cs'), 'utf8'));
const bindings = [];
async function bind(relative) {
  const bytes = await readFile(validationPath(path.join(repo, relative)));
  bindings.push({ path: relative.replaceAll('\\', '/'), sha256: sha256(bytes), bytes: bytes.length });
}
for (const name of ['Program.cs', 'Oracle.csproj', 'stdout.txt', 'process.json']) await bind(path.relative(repo, path.join(source, name)));
const root = '.test-input/baselines/jellyfin-current/source/';
for (const name of ['MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/UserView.cs',
  'MediaBrowser.Controller/Entities/TV/Episode.cs', 'MediaBrowser.Controller/Entities/TV/Season.cs',
  'Emby.Server.Implementations/Dto/DtoService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonNullableGuidConverter.cs',
  'src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs']) await bind(root + name);
for (const name of ['MediaBrowser.Controller', 'MediaBrowser.Model', 'Jellyfin.Server.Implementations',
  'Jellyfin.Database.Implementations', 'Jellyfin.Extensions', 'Emby.Server.Implementations']) {
  const relative = root + `Jellyfin.Server/bin/Release/net10.0/${name}.dll`;
  await bind(relative);
  const copied = await readFile(path.join(source, `bin/Release/net10.0/${name}.dll`));
  assert.equal(sha256(copied), bindings.at(-1).sha256, `actual oracle ${name} binding`);
}
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBindings: bindings,
  oracleSourceSha256: sha256(await readFile(path.join(fixture, 'Oracle.cs'))),
  verified: { nativeProcessExit: 0, actualFrozenBaseItemMapper: true, actualFrozenDisplayParentGetter: true,
    actualFrozenNullableGuidSerializer: true, explicitPersistedGuidAssignment: true, actualFullDtoServiceInvoked: false },
  result: result.result,
  limitations: 'This oracle calls the frozen BaseItemMapper and real virtual DisplayParentId getter, then serializes BaseItemDto.ParentId with the frozen nullable-Guid serializer. DtoService source is bound and its exact BaseItem-typed assignment is reproduced; the complete DtoService projection and HTTP controller are not invoked.'
}, null, 2) + '\n');
await writeFile(path.join(fixture, 'native.json'), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: sha256(bytes), bindings: bindings.length }));
