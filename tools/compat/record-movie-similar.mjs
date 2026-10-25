import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile } from '../validation/inventory.js';

const output = process.argv[2];
const source = process.env.MEDIAMANAGER_JELLYFIN_SOURCE;
if (!output || !source) throw new Error('Set MEDIAMANAGER_JELLYFIN_SOURCE to the clean isolated pin and supply a new output directory.');
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commit = git(['rev-parse', 'HEAD']);
if (commit !== '208c278b75abd897aefa1e1175126eac5e4dbfaa' || git(['status', '--short'])) {
  throw new Error('The native source must be the clean designated pin.');
}
const root = 'tests/library/fixtures/movie-similar';
const record = await recordOracle({ project: `${root}/Oracle.csproj`, output,
  args: [`${root}/input.json`, '{output}/native.raw.json'] });
const raw = path.join(output, 'native.raw.json');
const native = JSON.parse(await readFile(raw, 'utf8'));
const sourcePaths = [
  'Emby.Server.Implementations/Library/SimilarItems/MovieSimilarItemsProvider.cs',
  'Emby.Server.Implementations/Library/SimilarItems/LiveTvProgramSimilarItemsProvider.cs',
  'Emby.Server.Implementations/Library/SimilarItems/SimilarItemsManager.cs',
  'MediaBrowser.Providers/Plugins/Tmdb/Movies/TmdbMovieSimilarProvider.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'MediaBrowser.Controller/Library/SimilarItemsQuery.cs',
  'MediaBrowser.Model/Configuration/ServerConfiguration.cs',
  'Emby.Server.Implementations/Data/ItemTypeLookup.cs',
  'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinQueryHelperExtensions.cs',
];
const sources = await Promise.all(sourcePaths.map(async name => ({ name, ...await describeFile(path.join(source, name)) })));
const files = await Promise.all(['input.json', 'Program.cs', 'Oracle.csproj', 'README.md'].map(name => describeFile(path.join(root, name))));
const bin = path.dirname(record.oracleAssembly.filename);
const resolution = await Promise.all(['Oracle.deps.json', 'Oracle.runtimeconfig.json'].map(name => describeFile(path.join(bin, name))));
await writeFile(`${root}/native.json`, (await readFile(raw, 'utf8')).replaceAll('\r\n', '\n'));
const provenance = {
  schemaVersion: 1, candidateVerified: false, recordedAt: record.recordedAt,
  jellyfin: { source: path.resolve(source).replaceAll('\\', '/'), commit, sources },
  record: await describeFile(path.join(output, 'record.json')),
  raw: await describeFile(raw), native: await describeFile(`${root}/native.json`),
  files, resolution, dotnet: record.dotnet, jellyfinDll: record.jellyfinDll,
  runtimeScope: 'Runtime-loaded managed assemblies plus the native SQLite library; not a complete build-input dependency closure.',
};
await writeFile(`${root}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, output, nativeSha256: provenance.native.sha256 }));
