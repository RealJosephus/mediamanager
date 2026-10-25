import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile, sha256 } from '../validation/inventory.js';
import { repositoryRoot } from '../validation/paths.js';

const output = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node tools/compat/record-collection-source.mjs NEW_OUTPUT_DIRECTORY');
const fixture = path.join(repositoryRoot, 'tests/library/fixtures/collection-source');
const sourceFiles = [
  'Emby.Server.Implementations/Library/Validators/CollectionPostScanTask.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/UserView.cs', 'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'MediaBrowser.Controller/Entities/BasePluginFolder.cs', 'Emby.Server.Implementations/Playlists/PlaylistsFolder.cs',
  'MediaBrowser.Controller/Entities/Movies/Movie.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/DescendantQueryHelper.cs',
];
const builtSource = path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source');
const sources = await Promise.all(sourceFiles.map(async relative => {
  const designated = await describeFile(path.join('D:/jellyfin', relative));
  const compiledCopy = await describeFile(path.join(builtSource, relative));
  if (!designated.sha256 || designated.sha256 !== compiledCopy.sha256) throw new Error(`Reference source differs: ${relative}`);
  return { path: relative, sha256: designated.sha256, designatedSourceMatchesOracleBuildCopy: true };
}));
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output,
  args: ['{output}/case', path.join(fixture, 'input.json'), '{output}/native.json'] });
for (const source of sources) for (const root of ['D:/jellyfin', builtSource]) {
  if ((await describeFile(path.join(root, source.path))).sha256 !== source.sha256) throw new Error(`Reference source drifted: ${source.path}`);
}
const nativeBytes = await readFile(path.join(output, 'native.json'));
const native = JSON.parse(nativeBytes);
const dllDirectory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const assemblies = [];
for (const observed of native.assemblies) {
  const filename = path.join(dllDirectory, observed.name + '.dll');
  const entry = await describeFile(filename);
  if (!entry.available) continue;
  if (entry.sha256 !== observed.sha256) throw new Error(`Loaded assembly differs: ${observed.name}`);
  assemblies.push({ name: observed.name, sha256: observed.sha256, filename });
}
const proof = { nativeSha256: sha256(nativeBytes), inputSha256: sha256(await readFile(path.join(fixture, 'input.json'))),
  sources, oracleSources: record.sourceFiles.map(entry => ({ name: path.basename(entry.filename), sha256: entry.sha256 })),
  oracleAssembly: record.oracleAssembly, jellyfinDll: record.jellyfinDll, dotnet: record.dotnet,
  build: record.build, process: record.process, assemblies, sqliteRuntime: native.sqliteRuntime,
  rawRecording: await describeFile(path.join(output, 'native.json')), buildSource: builtSource,
  recorder: await describeFile(path.join(repositoryRoot, 'tools/compat/record-collection-source.mjs')),
  completeBuildInputClosure: false, phaseAcceptance: false };
await writeFile(path.join(output, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: true, output, queries: native.pages.length, roots: native.rootItems.length,
  designatedSources: sources.length, assemblies: assemblies.length }));
