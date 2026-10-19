import path from 'node:path';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { recordOracle } from '../validation/oracle.js';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Usage: node tools/compat/record-library-structure-http.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY');
const fixture = path.resolve('tests/http/fixtures/library-structure'), input = path.join(fixture, 'input.json');
const previousProof = await readFile(path.join(fixture, 'provenance.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const previousBytes = await readFile(path.join(fixture, 'native.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const buildSource = path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT ?? '', 'source');
if (!process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT) throw new Error('The isolated oracle build source root is required.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filenames = ['Jellyfin.Api/Controllers/LibraryStructureController.cs', 'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Api/ModelBinders/NullableEnumModelBinder.cs', 'Jellyfin.Api/Auth/CustomAuthenticationHandler.cs', 'MediaBrowser.Model/Entities/CollectionTypeOptions.cs',
  'Jellyfin.Api/Models/LibraryStructureDto/AddVirtualFolderDto.cs', 'Jellyfin.Api/Models/LibraryStructureDto/MediaPathDto.cs',
  'Jellyfin.Api/Models/LibraryStructureDto/UpdateMediaPathRequestDto.cs', 'Jellyfin.Api/Models/LibraryStructureDto/UpdateLibraryOptionsDto.cs',
  'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Auth/FirstTimeSetupPolicy/FirstTimeSetupHandler.cs',
  'Jellyfin.Api/Auth/FirstTimeSetupPolicy/FirstTimeSetupRequirement.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs', 'MediaBrowser.Controller/IO/FileSystemHelper.cs',
  'MediaBrowser.Controller/Entities/CollectionFolder.cs', 'MediaBrowser.Model/Configuration/LibraryOptions.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Providers/MetadataRefreshOptions.cs', 'MediaBrowser.Controller/Providers/ImageRefreshOptions.cs',
  'MediaBrowser.Model/Configuration/MediaPathInfo.cs', 'MediaBrowser.Model/Configuration/TypeOptions.cs'];
async function snapshot() {
  const sources = [];
  for (const filename of filenames) {
    const designated = await readFile(path.join('D:/jellyfin', filename)), copied = await readFile(path.join(buildSource, filename));
    if (!designated.equals(copied)) throw new Error(`Designated source differs from the oracle build copy: ${filename}`);
    sources.push({ filename, sha256: hash(designated), designatedSourceMatchesOracleBuildCopy: true });
  }
  return sources;
}
const before = await snapshot(), inputSha256 = hash(await readFile(input));
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output, args: [input, '{output}/native.json'] });
const after = await snapshot();
if (JSON.stringify(before) !== JSON.stringify(after) || hash(await readFile(input)) !== inputSha256) throw new Error('Native recording inputs changed.');
const nativeBytes = await readFile(path.join(output, 'native.json')), native = JSON.parse(nativeBytes);
const proof = { inputSha256, nativeSha256: hash(nativeBytes), rawRecording: path.join(output, 'native.json'), record: path.join(output, 'record.json'),
  sources: before, sourcesStable: true, oracleSources: record.sourceFiles.map(row => ({ filename: path.basename(row.filename), sha256: row.sha256 })),
  build: record.build, process: record.process, assemblies: native.assemblies,
  jellyfin: { dll: process.env.MEDIAMANAGER_JELLYFIN_DLL, buildSource },
  candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false };
if (previousProof?.inputSha256 === inputSha256 && previousBytes
  && JSON.stringify(previousProof.oracleSources) === JSON.stringify(proof.oracleSources)) {
  function observation(data, recording) {
    const normalize = (value, views) => typeof value === 'string' ? value.includes(views)
      ? value.replaceAll(views, '{views}').replace(/\{views\}[\\/][a-f0-9]{32}(?=$|[\\/])/gu, '{views}/temporary').replaceAll('\\','/') : value
      : Array.isArray(value) ? value.map(entry => normalize(entry, views)) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, normalize(entry, views)])) : value;
    return { markerTypes: data.markerTypes, results: data.results.map(row => {
      const views = path.join(path.dirname(recording), 'states', row.name, 'root', 'default');
      const moves = row.calls.filter(call => call.action === 'move');
      if (moves.length === 2 && moves[0].value.to !== moves[1].value.from) throw new Error('Native temporary move identity changed.');
      return { ...normalize(row, views), body: row.jsonBody !== null ? null : row.body,
        files: row.files.map(filename => filename.replaceAll('\\','/').replace(/^[a-f0-9]{32}\//u, 'temporary/')).sort() };
    }) };
  }
  if (JSON.stringify(observation(JSON.parse(previousBytes), previousProof.rawRecording)) !== JSON.stringify(observation(native, proof.rawRecording))) {
    throw new Error('Independent native capture changed the observable library structure contract.');
  }
  proof.repeat = { filename: previousProof.rawRecording, sha256: previousProof.nativeSha256, sameInputAndOracleSources: true };
}
await copyFile(path.join(output, 'native.json'), path.join(fixture, 'native.json'));
await writeFile(path.join(fixture, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: native.results.length, passed: record.passed }));
