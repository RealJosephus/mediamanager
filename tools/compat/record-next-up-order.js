import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
// Record actual frozen-DLL episode and media-source ordering arithmetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument] = process.argv.slice(2);
if (!outputArgument) throw new Error('Usage: node tools/compat/record-next-up-order.js <new-evidence-directory>');
const output = validationPath(path.resolve(root, outputArgument)), evidenceRoot = validationOutputRoot();
if (!output.startsWith(evidenceRoot + path.sep) || existsSync(output)) throw new Error('Output must be a new evidence child directory.');
await mkdir(output, { recursive: true });
const episodes = [];
const values = [null, -2147483648, -1, 0, 1, 1000, 2147483647];
for (const season of values) for (const index of values) episodes.push({ ParentIndexNumber: season, IndexNumber: index });
for (const date of ['2026-09-29T12:00:00.0000000Z', '2026-09-29T12:00:00.0000001Z', '0001-01-01T00:00:00.0000000Z']) {
  episodes.push({ ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: date });
}
for (const field of ['AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber']) for (const season of values) {
  for (const index of [null, -2147483648, 1, 2147483647]) episodes.push({ ParentIndexNumber: 0, IndexNumber: index,
    [field]: season, AirsBeforeEpisodeNumber: index });
}
episodes.push({ ParentIndexNumber: 0, IndexNumber: -1, AirsAfterSeasonNumber: 2, AirsBeforeSeasonNumber: 1, AirsBeforeEpisodeNumber: -2147483648 });
const mediaSources = [null];
for (const sourcePath of [null, '', 'file', 'FILE', 'other', 'κ', 'Κ', 'K', 'k', 'ß', 'SS']) {
  mediaSources.push({ Path: sourcePath, MediaStreams: [] });
  for (const width of [null, -2147483648, -1, 0, 1, 2147483647]) {
    mediaSources.push({ Path: sourcePath, MediaStreams: [{ Type: 'Audio', Width: 4096 }, { Type: 'Video', Width: width }] });
  }
}
for (const [index, source] of mediaSources.entries()) if (source) {
  source.Id = index.toString(16).padStart(32, '0');
  source.VideoType = [null, 'VideoFile', 'Dvd', 'BluRay', 'Iso'][index % 5];
  source.Video3DFormat = index % 3 ? null : 'HalfSideBySide';
}
const widthSequences = [];
const boundarySources = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 35, 42, 49, 56, 63, 70, 77];
for (const length of [1, 2, 3, 4, 15, 16, 17, 31, 32, 33, 57, 78]) for (let seed = 1; seed <= 12; seed++) {
  let random = seed;
  widthSequences.push(Array.from({ length }, () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return boundarySources[random % boundarySources.length];
  }));
}
widthSequences.push(Array.from({ length: 78 }, (_, index) => 1 + index % (mediaSources.length - 1)));
for (const a of [16, 17, 18, 19, 20, 21]) for (const b of [16, 17, 18, 19, 20, 21]) for (const c of [16, 17, 18, 19, 20, 21]) {
  widthSequences.push([a, b, c]);
}
const json = value => JSON.stringify(value, null, 2) + '\n';
const fullSourceSequences = widthSequences.map((indices, index) => ({ indices,
  preferredId: index % 3 === 0 ? '' : mediaSources[indices[index % indices.length]].Id }));
await writeFile(path.join(output, 'input.json'), json({ episodes, mediaSources, widthSequences, fullSourceSequences }), { flag: 'wx' });
const command = [validationExecutable('dotnet'), 'run', '--project',
  validationPath(path.join(root, 'tests/library/fixtures/next-up/OrderOracle.csproj')),
  `--property:BaseIntermediateOutputPath=${path.join(output, 'obj')}${path.sep}`,
  `--property:OutputPath=${path.join(output, 'bin')}${path.sep}`,
  '--', path.join(output, 'input.json'), path.join(output, 'comparisons.json')];
const result = await new Promise(resolve => {
  const child = spawn(command[0], command.slice(1), { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', error => resolve({ code: null, signal: null, stdout, stderr, error: error.message }));
  child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
});
await writeFile(path.join(output, 'process.json'), json({ command, ...result }), { flag: 'wx' });
assert.equal(result.code, 0, result.stderr || result.stdout);
const { comparisons, widthComparisons, widthDescendingPairOrder, widthSequenceOrder, fullSourceSequenceOrder,
  bindingValidation, runtime } = JSON.parse(await readFile(path.join(output, 'comparisons.json')));
assert.deepEqual(bindingValidation, { episodes: episodes.length, mediaSources: mediaSources.length });
assert.equal(comparisons.length, episodes.length);
for (const row of comparisons) { assert.equal(row.length, episodes.length); assert.ok(row.every(value => [-1, 0, 1].includes(value))); }
assert.equal(widthComparisons.length, mediaSources.length);
for (const row of widthComparisons) { assert.equal(row.length, mediaSources.length); assert.ok(row.every(Number.isInteger)); }
assert.equal(widthDescendingPairOrder.length, mediaSources.length);
for (const [left, row] of widthDescendingPairOrder.entries()) for (const [right, pair] of row.entries()) {
  assert.equal(row.length, mediaSources.length);
  assert.deepEqual([...pair].sort((a, b) => a - b), [left, right].sort((a, b) => a - b));
}
assert.equal(widthSequenceOrder.length, widthSequences.length);
for (const [index, order] of widthSequenceOrder.entries()) {
  assert.deepEqual([...order].sort((a, b) => a - b), widthSequences[index].map((_source, index) => index));
}
assert.equal(fullSourceSequenceOrder.length, fullSourceSequences.length);
for (const [index, order] of fullSourceSequenceOrder.entries()) {
  assert.deepEqual([...order].sort((a, b) => a - b), fullSourceSequences[index].indices.map((_source, index) => index));
}
assert.match(runtime.frameworkDescription, /^\.NET 10\./u);
const sourceFiles = ['tests/library/fixtures/next-up/OrderOracle.csproj', 'tests/library/fixtures/next-up/OrderOracle.cs',
  '.test-input/baselines/jellyfin-current/source/Emby.Server.Implementations/Sorting/AiredEpisodeOrderComparer.cs',
  '.test-input/baselines/jellyfin-current/source/MediaBrowser.Controller/Entities/MediaSourceWidthComparator.cs',
  '.test-input/baselines/jellyfin-current/source/MediaBrowser.Controller/Entities/BaseItem.cs',
  '.test-input/baselines/jellyfin-current/source/MediaBrowser.Model/Dto/MediaSourceInfo.cs',
  '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/MediaBrowser.Controller.dll',
  '.tools/dotnet/shared/Microsoft.NETCore.App/10.0.12/System.Private.CoreLib.dll',
  '.tools/dotnet/shared/Microsoft.NETCore.App/10.0.12/System.Linq.dll',
  '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/Emby.Server.Implementations.dll'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = { schemaVersion: 1, episodes, comparisons, mediaSources, widthComparisons, widthDescendingPairOrder,
  widthSequences, widthSequenceOrder, bindingValidation,
  fullSourceSequences, fullSourceSequenceOrder, runtime,
  source: Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name,
  sha256(await readFile(validationPath(path.join(root, name))))]))), result: { code: result.code, signal: result.signal }, phaseAcceptance: false };
await writeFile(path.join(output, 'native.json'), json(fixture), { flag: 'wx' });
console.log(JSON.stringify({ output: outputArgument, episodes: episodes.length, comparisons: episodes.length ** 2,
  mediaSources: mediaSources.length, widthComparisons: mediaSources.length ** 2,
  widthSequences: widthSequences.length,
  fullSourceSequences: fullSourceSequences.length, runtime,
  result: fixture.result, phaseAcceptance: false }));
