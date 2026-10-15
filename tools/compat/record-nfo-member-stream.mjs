import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordOracle } from '../validation/oracle.js';
import { describeFile } from '../validation/inventory.js';

const [output, buildSource, designatedSource = 'D:/jellyfin'] = process.argv.slice(2);
if (!output || !path.isAbsolute(buildSource ?? '') || !path.isAbsolute(designatedSource)
  || !process.env.MEDIAMANAGER_JELLYFIN_DLL) {
  throw new Error('Supply a new output directory, the isolated build source, the designated source, and MEDIAMANAGER_JELLYFIN_DLL.');
}
const fixture = new URL('../../tests/metadata/fixtures/nfo-member-stream/', import.meta.url);
const fixtureFile = name => fileURLToPath(new URL(name, fixture));
const sourcePaths = ['MediaBrowser.XbmcMetadata/Savers/AlbumNfoSaver.cs','MediaBrowser.XbmcMetadata/Savers/ArtistNfoSaver.cs','MediaBrowser.XbmcMetadata/Savers/BaseNfoSaver.cs','MediaBrowser.Controller/Entities/Folder.cs','MediaBrowser.Controller/Entities/Audio/MusicAlbum.cs','MediaBrowser.Controller/Entities/Audio/MusicArtist.cs','MediaBrowser.Controller/Entities/BaseItem.cs'];
const sources = await Promise.all(sourcePaths.map(async filename => {
  const [designated, isolated] = await Promise.all([
    describeFile(path.join(designatedSource, filename)), describeFile(path.join(buildSource, filename)),
  ]);
  if (!designated.available || !isolated.available || designated.sha256 !== isolated.sha256) {
    throw new Error(`The isolated build source differs from the designated source: ${filename}`);
  }
  return { path: filename, sha256: designated.sha256, designatedSourceMatchesOracleBuildCopy: true, designated, isolated };
}));
const dllDirectory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const dependencies = await Promise.all((await readdir(dllDirectory)).filter(name => /\.(dll|json)$/u.test(name)).sort()
  .map(name => describeFile(path.join(dllDirectory, name))));
const runtimeDependencies = [];
const shared = path.join(process.env.MEDIAMANAGER_DOTNET_ROOT ?? path.dirname(process.env.MEDIAMANAGER_DOTNET ?? ''), 'shared');
for (const framework of (await readdir(shared)).sort()) {
  for (const version of (await readdir(path.join(shared, framework))).sort()) {
    const directory = path.join(shared, framework, version);
    for (const name of (await readdir(directory)).filter(value => /\.(dll|json)$/u.test(value)).sort()) {
      runtimeDependencies.push(await describeFile(path.join(directory, name)));
    }
  }
}
const fixtureSources = await Promise.all(['input.json', 'Program.cs', 'Oracle.csproj'].map(name => describeFile(fixtureFile(name))));
fixtureSources.push(await describeFile(path.resolve('tests/Directory.Build.props')));
const recorder = await describeFile(fileURLToPath(import.meta.url));
const record = await recordOracle({ project: fixtureFile('Oracle.csproj'), output,
  args: [fixtureFile('input.json'), '{output}/native.json'] });
const nativeBytes = await readFile(path.join(output, 'native.json'));
const native = JSON.parse(nativeBytes);
for (const assembly of native.assemblies) {
  const original = [...dependencies, ...runtimeDependencies, record.oracleAssembly]
    .find(value => path.basename(value.filename) === path.basename(assembly.location) && value.sha256 === assembly.sha256);
  if (!original || (await describeFile(assembly.location)).sha256 !== assembly.sha256) {
    throw new Error(`Loaded oracle assembly differs: ${assembly.location}`);
  }
}
const before = [...fixtureSources, recorder, ...dependencies, ...runtimeDependencies, ...sources.flatMap(source => [source.designated, source.isolated])];
const after = await Promise.all(before.map(file => describeFile(file.filename)));
for (let index = 0; index < before.length; index++) {
  if (after[index].sha256 !== before[index].sha256) throw new Error(`Oracle input changed: ${before[index].filename}`);
}
await writeFile(path.join(output, 'sources-before.json'), JSON.stringify(before, null, 2));
await writeFile(path.join(output, 'sources-after.json'), JSON.stringify(after, null, 2));
await writeFile(fixtureFile('native.json'), nativeBytes);
const oracleSources = await Promise.all(['Oracle.csproj', 'Program.cs'].map(async name => ({ name,
  sha256: (await describeFile(fixtureFile(name))).sha256 })));
oracleSources.push({ name: 'Directory.Build.props', sha256: (await describeFile('tests/Directory.Build.props')).sha256 });
const provenance = {
  recordedAt: record.recordedAt, buildSource, designatedSource,
  inputSha256: (await describeFile(fixtureFile('input.json'))).sha256,
  nativeSha256: (await describeFile(fixtureFile('native.json'))).sha256,
  sources, oracleSources, oracleAssembly: record.oracleAssembly, jellyfinDll: record.jellyfinDll,
  dotnet: record.dotnet, build: record.build, process: record.process,
  dependencies, runtimeDependencies, actualLoadedAssemblies: native.assemblies,
  rawRecording: await describeFile(path.join(output, 'native.json')),
  record: await describeFile(path.join(output, 'record.json')), recorder,
  sourceInputsStable: true, candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false,
};
await writeFile(fixtureFile('provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, output, cases: native.results.length, culture: native.culture, nativeSha256: provenance.nativeSha256 }));
