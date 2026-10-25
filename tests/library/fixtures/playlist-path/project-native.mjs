import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const target = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(target, '../../../..');
const source = path.resolve(process.argv[2]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = [];
async function load(full) {
  const bytes = await readFile(full); inputs.push({ path: path.relative(repo, full).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) });
  return { bytes, raw: JSON.parse(bytes) };
}
const { bytes: rawBytes, raw } = await load(path.join(source, 'stdout.txt'));
const { raw: exit } = await load(path.join(source, 'exit.json'));
const { raw: summary } = await load(path.join(source, 'summary.json'));
const { raw: initial } = await load(path.join(source, 'candidate-initial.json'));
const { raw: processes } = await load(path.join(source, 'resource-processes.json'));
const { raw: clrProvenance } = await load(path.join(source, 'clr-provenance.json'));
const rootsSource = path.resolve(source, '../playlist-path-root-native-v1');
const { raw: roots } = await load(path.join(rootsSource, 'stdout.txt'));
const { raw: rootsExit } = await load(path.join(rootsSource, 'exit.json'));
const { raw: rootsProcesses } = await load(path.join(rootsSource, 'resource-processes.json'));
for (const directory of [source, rootsSource]) for (const file of ['Program.cs', 'Oracle.csproj']) {
  const full = path.join(directory, file), bytes = await readFile(full);
  inputs.push({ path: path.relative(repo, full).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) });
}
for (const entry of clrProvenance.sources) {
  const full = path.join(source, 'clr-source', entry.name), bytes = await readFile(full);
  assert.equal(hash(bytes), entry.sha256);
  inputs.push({ path: path.relative(repo, full).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) });
}
assert.deepEqual([exit.buildCode, exit.processCode, rootsExit.buildCode, rootsExit.processCode], [0, 0, 0, 0]);
assert.equal(processes.reclaimed, true); assert.equal(rootsProcesses.reclaimed, true);
assert.equal(raw.Windows, true); assert.equal(raw.results.length, 16); assert.equal(raw.subpathControls.length, 7);
assert.equal(roots.results.length, 25);
for (const binding of summary.nativeSourceBindings) assert.equal(hash(await readFile(path.join(repo, binding.path))), binding.sha256);
for (const binding of summary.nativeAssemblyBindings) assert.equal(hash(await readFile(path.join(source, 'loaded-assemblies', path.basename(binding.path)))), binding.sha256);
assert.equal(summary.differences, 6); assert.equal(summary.containsDifferences, 3);
assert.deepEqual(raw.assemblies, summary.nativeAssemblyBindings.map(binding => ({ name: binding.name, path: binding.path, sha256: binding.sha256 })));
const oracle = await readFile(path.join(source, 'Program.cs'));
const fixture = { format: 1, frozenJellyfin: true, raw, sourceBindings: inputs, nativeSourceBindings: summary.nativeSourceBindings,
  nativeAssemblyBindings: summary.nativeAssemblyBindings, oracleSourceSha256: hash(oracle), rawOutputSha256: hash(rawBytes),
  initial: { comparisons: initial.comparisons, containsComparisons: initial.containsComparisons,
    candidateSourceBindings: summary.sourceBindings, sourceStable: summary.sourceStable, differences: summary.differences, containsDifferences: summary.containsDifferences },
  supplementalRoots: roots, clrProvenance, audit: { actualWindowsRuntime: true, processExit: 0, caseCount: 23, rootControlCount: 25,
    processesReclaimed: true, phaseAcceptance: false },
  scope: raw.sourceBoundary,
  limitations: 'Twenty-three actual Windows getter/Contains/visibility cases with controlled dependencies, plus twenty-five supplemental runtime root-trimming observations. Published CLR source tag and observed runtime commit are separately bound. No actual non-Windows native run, database, HTTP/host or cancellation proof. Original 18 UserView/8 redirected search HTTP fixture scopes are unchanged.' };
await mkdir(target, { recursive: true });
await writeFile(path.join(target, 'native.json'), JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
await copyFile(path.join(source, 'Program.cs'), path.join(target, 'Oracle.cs'));
console.log(JSON.stringify({ fixtureSha256: hash(await readFile(path.join(target, 'native.json'))), oracleSha256: hash(oracle), sourceBindings: inputs.length }));
