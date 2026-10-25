import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(process.argv[2]), repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stdout = await readFile(path.join(source, 'stdout.txt'));
const result = JSON.parse(stdout);
assert.equal(result.actualFrozenDynamicProvider, true);
assert.equal(result.collageProcessorIsControlled, true);
assert.equal(result.output.length, 5);
const paths = ['Program.cs', 'Oracle.csproj', 'stdout.txt'];
const bindings = [];
for (const name of paths) { const bytes = await readFile(path.join(source, name)); bindings.push({ path: path.relative(repo, path.join(source, name)).replaceAll('\\', '/'), sha256: sha256(bytes), bytes: bytes.length }); }
for (const name of ['Emby.Server.Implementations/Images/BaseDynamicImageProvider.cs', 'Emby.Server.Implementations/Images/DynamicImageProvider.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs', 'MediaBrowser.Controller/Entities/Folder.cs', 'Jellyfin.Server/bin/Release/net10.0/Emby.Server.Implementations.dll']) {
  const relative = '.test-input/baselines/jellyfin-current/source/' + name;
  const bytes = await readFile(path.join(repo, relative)); bindings.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
}
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBindings: bindings,
  verified: { nativeProcessExit: 0, actualFrozenDynamicProvider: true, actualManagedFileSystem: true, controlledSourceQuery: true, controlledCollageProcessor: true },
  output: result.output,
  limitations: 'Controlled UserView overrides only GetItemsInternal and internal path. Collage processor and SaveImage are interface proxies. Query errors and cancellation ordering are observed in the actual frozen provider; real collage pixels, real SaveImage persistence and complete host/native refresh cancellation or races are not verified.'
}, null, 2) + '\n');
await writeFile(new URL('./native.json', import.meta.url), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: sha256(bytes) }));
