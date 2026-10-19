import { validationPath } from '../validation/paths.js';
// Preserve the actual frozen comparer/.NET LINQ observations byte-for-byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = '.agent-docs/evidence/memory-sort-boundary-audit-v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(validationPath(path.join(repo, directory, 'native.json')));
const native = JSON.parse(bytes.toString('utf8'));
assert.equal(native.actualFrozenDllComparersInvoked, true);
assert.equal(native.actualLinqOrderByInvoked, true);
assert.equal(native.libraryManagerInvoked, false);
assert.equal(native.httpInvoked, false);
assert.equal(native.databaseOpened, false);
assert.equal(native.output.length, 4);
for (const assembly of native.assemblies) {
  const frozenBytes = await readFile(validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0', assembly.assembly + '.dll')));
  assert.equal(sha256(frozenBytes), assembly.sha256);
}
const output = 'tests/library/fixtures/boxset-display-order/boundary-native.json';
await copyFile(validationPath(path.join(repo, directory, 'native.json')), validationPath(path.join(repo, output)), 1);
assert.equal(sha256(await readFile(validationPath(path.join(repo, output)))), sha256(bytes));
const oracleBytes = await readFile(validationPath(path.join(repo, directory, 'Program.cs')));
await copyFile(validationPath(path.join(repo, directory, 'Program.cs')), validationPath(path.join(repo, 'tests/library/fixtures/boxset-display-order/BoundaryOracle.cs')), 1);
const binding = { phaseAcceptance: false, output, bytes: bytes.length, sha256: sha256(bytes),
  oracleSourceSha256: sha256(oracleBytes), projectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  actualComparerNames: native.output.map(row => row.name), actualOrderSequences: native.output.length * 2,
  scope: 'Controlled domain objects/UserData with actual frozen comparers and .NET LINQ. LibraryManager, HTTP, database and authentication were not invoked.' };
await writeFile(validationPath(path.join(repo, directory, 'fixture-projection.json')), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(binding));
