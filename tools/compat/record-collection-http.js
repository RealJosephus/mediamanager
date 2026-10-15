import path from 'node:path';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { recordOracle } from '../validation/oracle.js';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Usage: node tools/compat/record-collection-http.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY');
const fixture = path.resolve('tests/http/fixtures/collections');
const input = path.join(fixture, 'input.json');
const previousBytes = await readFile(path.join(fixture, 'native.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const previousProof = await readFile(path.join(fixture, 'provenance.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output,
  args: [input, '{output}/native.json'] });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeBytes = await readFile(path.join(output, 'native.json'));
const native = JSON.parse(nativeBytes);
const directory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const buildSource = process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT && path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source');
if (!buildSource) throw new Error('The isolated oracle build source root is required.');
const sourcePaths = ['Jellyfin.Api/Controllers/CollectionController.cs', 'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs',
  'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionRequirement.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'MediaBrowser.Controller/Dto/DtoOptions.cs', 'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
  'Emby.Server.Implementations/Collections/CollectionManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs'];
const sources = [];
for (const filename of sourcePaths) {
  const designated = await readFile(path.join('D:/jellyfin', filename));
  const copied = await readFile(path.join(buildSource, filename));
  if (!designated.equals(copied)) throw new Error(`Designated source differs from the oracle build copy: ${filename}`);
  sources.push({ filename, sha256: hash(designated), designatedSourceMatchesOracleBuildCopy: true });
}
const proof = { inputSha256: hash(await readFile(input)), nativeSha256: hash(nativeBytes),
  rawRecording: path.join(output, 'native.json'), record: path.join(output, 'record.json'), sources,
  oracleSources: record.sourceFiles.map(row => ({ filename: path.basename(row.filename), sha256: row.sha256 })),
  build: record.build, process: record.process, assemblies: native.assemblies,
  jellyfin: { dll: process.env.MEDIAMANAGER_JELLYFIN_DLL, assemblyDirectory: directory, buildSource },
  candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false };
if (previousBytes && previousProof?.inputSha256 === proof.inputSha256 && JSON.stringify(previousProof.oracleSources) === JSON.stringify(proof.oracleSources)) {
  const noTrace = value => Array.isArray(value) ? value.map(noTrace) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, noTrace(entry)])) : value;
  const observation = row => ({ ...row, body: row.jsonBody !== null ? null : row.body, jsonBody: noTrace(row.jsonBody) });
  const first = JSON.parse(previousBytes).results.map(observation), second = native.results.map(observation);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Independent native capture changed the observable HTTP/manager contract.');
  proof.repeat = { filename: previousProof.rawRecording, sha256: previousProof.nativeSha256, sameInputAndOracleSources: true };
}
await copyFile(path.join(output, 'native.json'), path.join(fixture, 'native.json'));
await writeFile(path.join(fixture, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: native.results.length, passed: record.passed }));
