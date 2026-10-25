import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile, sha256 } from '../validation/inventory.js';
import { repositoryRoot } from '../validation/paths.js';

const output = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node tools/compat/record-guid-contract.mjs NEW_OUTPUT_DIRECTORY');
const fixture = path.join(repositoryRoot, 'tests/users/fixtures/guid-contract');
const buildSource = path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source');
const sourceFiles = ['src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs',
  'src/Jellyfin.Extensions/Json/Converters/JsonNullableGuidConverter.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs'];
const sources = await Promise.all(sourceFiles.map(async relative => {
  const designated = await describeFile(path.join('D:/jellyfin', relative));
  const built = await describeFile(path.join(buildSource, relative));
  if (!designated.sha256 || designated.sha256 !== built.sha256) throw new Error('Reference source differs: ' + relative);
  return { path: relative, sha256: designated.sha256 };
}));
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output,
  args: ['{output}/case', path.join(fixture, 'input.json'), '{output}/native.json'] });
const bytes = await readFile(path.join(output, 'native.json'));
const native = JSON.parse(bytes), dllDirectory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const matchingLibraryAssemblies = [];
for (const observed of native.assemblies) {
  const actual = await describeFile(observed.filename);
  if (actual.sha256 !== observed.sha256) throw new Error('Executed assembly changed: ' + observed.name);
  const baseline = await describeFile(path.join(dllDirectory, observed.name + '.dll'));
  if (baseline.available) {
    if (baseline.sha256 !== observed.sha256) throw new Error('Loaded library differs: ' + observed.name);
    matchingLibraryAssemblies.push({ name: observed.name, ...baseline });
  }
}
for (const source of sources) for (const root of ['D:/jellyfin', buildSource]) {
  if ((await describeFile(path.join(root, source.path))).sha256 !== source.sha256) throw new Error('Source drifted: ' + source.path);
}
const proof = { inputSha256: sha256(await readFile(path.join(fixture, 'input.json'))), nativeSha256: sha256(bytes), sources,
  buildSource, oracleSources: record.sourceFiles.map(source => ({ name: path.basename(source.filename), sha256: source.sha256 })),
  oracleAssembly: record.oracleAssembly, dotnet: record.dotnet, jellyfinDll: record.jellyfinDll,
  build: record.build, process: record.process, rawRecording: await describeFile(path.join(output, 'native.json')),
  assemblies: native.assemblies, matchingLibraryAssemblies, completeBuildInputClosure: false, phaseAcceptance: false };
await writeFile(path.join(output, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: true, output, cases: native.cases.length,
  matchingLibraryAssemblies: matchingLibraryAssemblies.length }));
