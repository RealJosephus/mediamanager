import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile } from '../validation/inventory.js';

const output = process.argv[2], source = process.env.MEDIAMANAGER_JELLYFIN_SOURCE;
if (!output || !source) throw new Error('Supply a new output directory and the isolated MEDIAMANAGER_JELLYFIN_SOURCE.');
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commit = git(['rev-parse', 'HEAD']);
if (commit !== '208c278b75abd897aefa1e1175126eac5e4dbfaa' || git(['status', '--short'])) {
  throw new Error('The native source must be the clean designated pin.');
}
const root = 'tests/library/fixtures/collection-playlist-resolution';
const record = await recordOracle({ project: `${root}/Oracle.csproj`, output,
  args: [`${root}/input.json`, '{output}/native.raw.json', '{output}/state'] });
const raw = path.join(output, 'native.raw.json');
const sourcePaths = [
  'Emby.Server.Implementations/Library/Resolvers/Movies/BoxSetResolver.cs',
  'Emby.Server.Implementations/Library/Resolvers/PlaylistResolver.cs',
  'Emby.Server.Implementations/Library/Resolvers/GenericFolderResolver.cs',
  'Emby.Server.Implementations/Library/ResolverHelper.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/ApplicationHost.cs',
  'MediaBrowser.Controller/Library/ItemResolveArgs.cs',
  'MediaBrowser.Controller/Resolvers/ItemResolver.cs',
  'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Playlists/Playlist.cs',
  'MediaBrowser.Controller/Entities/Movies/BoxSet.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
];
const sources = await Promise.all(sourcePaths.map(async name => ({ name, ...await describeFile(path.join(source, name)) })));
const files = await Promise.all(['input.json', 'Program.cs', 'Oracle.csproj', 'README.md'].map(name => describeFile(path.join(root, name))));
const bin = path.dirname(record.oracleAssembly.filename);
const resolution = await Promise.all(['Oracle.deps.json', 'Oracle.runtimeconfig.json'].map(name => describeFile(path.join(bin, name))));
await writeFile(`${root}/native.json`, (await readFile(raw, 'utf8')).replaceAll('\r\n', '\n'));
const provenance = { candidateVerified: false, recordedAt: record.recordedAt,
  jellyfin: { source: path.resolve(source).replaceAll('\\', '/'), commit, sources },
  record: await describeFile(path.join(output, 'record.json')), raw: await describeFile(raw),
  native: await describeFile(`${root}/native.json`), files, resolution, dotnet: record.dotnet, jellyfinDll: record.jellyfinDll,
  runtimeScope: 'Runtime-loaded managed assemblies and native SQLite; not the complete native build-input closure.' };
await writeFile(`${root}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, output, nativeSha256: provenance.native.sha256 }));
