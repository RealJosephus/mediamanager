import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile } from '../validation/inventory.js';

const [output, buildSource, designatedSource = 'D:/jellyfin'] = process.argv.slice(2);
if (!output || !path.isAbsolute(buildSource ?? '') || !path.isAbsolute(designatedSource)
  || !process.env.MEDIAMANAGER_JELLYFIN_DLL) {
  throw new Error('Supply a new output directory, the isolated build source, the designated source, and MEDIAMANAGER_JELLYFIN_DLL.');
}

const fixture = 'tests/library/fixtures/collection-post-scan';
const sourcePaths = [
  'Emby.Server.Implementations/Library/Validators/CollectionPostScanTask.cs',
  'MediaBrowser.Controller/Entities/Movies/Movie.cs',
  'MediaBrowser.Controller/Collections/CollectionCreationOptions.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
];
const sources = await Promise.all(sourcePaths.map(async filename => {
  const [designated, isolated] = await Promise.all([
    describeFile(path.join(designatedSource, filename)), describeFile(path.join(buildSource, filename)),
  ]);
  if (!designated.available || !isolated.available || designated.sha256 !== isolated.sha256) {
    throw new Error(`The isolated build source differs from the designated source: ${filename}`);
  }
  return { path: filename, sha256: designated.sha256, designatedSourceMatchesOracleBuildCopy: true,
    designated, isolated };
}));
const dllDirectory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const dependencyNames = (await readdir(dllDirectory)).filter(name => /\.(dll|json)$/u.test(name)).sort();
const dependencies = await Promise.all(dependencyNames.map(name => describeFile(path.join(dllDirectory, name))));
const record = await recordOracle({ project: `${fixture}/Oracle.csproj`, output,
  args: [`${fixture}/input.json`, '{output}/native.json'] });
const after = await Promise.all([...dependencies.map(file => describeFile(file.filename)),
  ...sources.flatMap(source => [describeFile(source.designated.filename), describeFile(source.isolated.filename)])]);
const before = [...dependencies, ...sources.flatMap(source => [source.designated, source.isolated])];
for (let index = 0; index < before.length; index++) {
  if (after[index].sha256 !== before[index].sha256) throw new Error(`Oracle input changed: ${before[index].filename}`);
}

const raw = await readFile(path.join(output, 'native.json'));
await writeFile(`${fixture}/native.json`, raw);
const oracleSources = await Promise.all(['Oracle.csproj', 'Program.cs'].map(async name => ({ name,
  sha256: (await describeFile(`${fixture}/${name}`)).sha256 })));
oracleSources.push({ name: 'Directory.Build.props', sha256: (await describeFile('tests/Directory.Build.props')).sha256 });
const provenance = {
  recordedAt: record.recordedAt,
  inputSha256: (await describeFile(`${fixture}/input.json`)).sha256,
  nativeSha256: (await describeFile(`${fixture}/native.json`)).sha256,
  sources, oracleSources, oracleAssembly: record.oracleAssembly, jellyfinDll: record.jellyfinDll,
  dotnet: record.dotnet, build: record.build, process: record.process,
  dependencies, record: await describeFile(path.join(output, 'record.json')),
  recorder: await describeFile('tools/compat/record-collection-post-scan.mjs'),
  candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false,
  controlledManagerCondition: 'GetItemList returns a fresh BoxSet cohort; RenameFirstBox mutates an independent cached manager instance.',
  fullLibraryManagerExecution: false,
  instanceIdentitySourceMethods: ['LibraryManager.GetItemList', 'BaseItemRepository.GetItemList', 'BaseItemMapper.DeserializeBaseItem'],
};
await writeFile(`${fixture}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, output, observations: JSON.parse(raw).results.length,
  nativeSha256: provenance.nativeSha256 }));
