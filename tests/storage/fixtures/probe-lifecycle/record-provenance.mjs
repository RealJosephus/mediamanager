import { validationExecutable, validationFileUrl, validationPath } from '../../../../tools/validation/paths.js';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const fixture = fileURLToPath(validationFileUrl('.', import.meta.url)), root = path.resolve(fixture, '../../../..');
const evidence = path.resolve(process.argv[2]), frozen = validationPath(path.join(root, '.test-input/baselines/jellyfin-current/source'));
await mkdir(evidence, { recursive: true });
const hash = async name => createHash('sha256').update(await readFile(name)).digest('hex');
const sources = ['MediaBrowser.Providers/MediaInfo/ProbeProvider.cs', 'MediaBrowser.Providers/Manager/MetadataService.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/Entities/BaseItemExtensions.cs',
  'MediaBrowser.Providers/MediaInfo/AudioFileProber.cs', 'MediaBrowser.Providers/MediaInfo/MediaInfoResolver.cs', 'MediaBrowser.Providers/MediaInfo/LyricResolver.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs'];
const sourceHashes = await Promise.all(sources.map(async name => ({ path: name, currentSha256: await hash(path.join(process.env.MEDIAMANAGER_JELLYFIN_SOURCE || 'D:/jellyfin', name)), frozenSha256: await hash(path.join(frozen, name)) })));
if (sourceHashes.some(record => record.currentSha256 !== record.frozenSha256)) throw new Error('The current Jellyfin source no longer matches the executed frozen assemblies.');
const artifacts = ['Oracle.cs', 'Oracle.csproj', 'SelectionOracle.cs', 'NativeReader.cs', 'create-input.mjs', 'input.json', 'native.json', 'selection.json', 'verify-native.mjs', 'record-provenance.mjs'];
const assemblies = ['MediaBrowser.Providers.dll', 'MediaBrowser.Controller.dll', 'MediaBrowser.Model.dll', 'Emby.Naming.dll', 'Jellyfin.Server.Implementations.dll', 'Jellyfin.Database.Implementations.dll', 'runtimes/win-x64/native/e_sqlite3.dll'];
const alist = validationPath(path.join(root, '.test-input/evidence/runtime-integration-20260926/alist/alist.exe'));
const ffprobe = spawnSync('where.exe', ['ffprobe'], { windowsHide: true, encoding: 'utf8' }).stdout.trim().split(/\r?\n/u)[0];
const provenance = {
  recordedAt: new Date().toISOString(), reference: 'D:/jellyfin including local modifications, read-only; frozen DLLs executed in an isolated harness',
  sourceHashes, artifacts: await Promise.all(artifacts.map(async name => ({ path: name, sha256: await hash(path.join(fixture, name)) }))),
  assemblies: await Promise.all(assemblies.map(async name => ({ path: name, sha256: await hash(path.join(frozen, 'Jellyfin.Server/bin/Release/net10.0', name)) }))),
  tools: await Promise.all([process.execPath, validationExecutable('dotnet'), ffprobe, alist].map(async filename => ({ path: filename, sha256: await hash(filename) }))),
  oracle: {
    changeCases: 37, selectionCases: 90,
    methods: ['ProbeProvider.HasChanged', 'ProbeProvider.IsMissingMediaInfo', 'ProbeProvider.FetchVideoInfo/FetchAudioInfo early returns', 'LyricResolver.GetExternalStreams', 'MetadataService<Movie,MovieInfo>.GetProviders'],
    boundaries: 'Native objects are assigned through actual CLR properties because native persistence columns are JsonIgnore. Directory/filesystem/protocol/language dependencies are isolated stubs. Active recording is false. Fetch gates stop at an explicitly null prober dependency; ProberBoundary means allowed past native early returns, not a successful native media probe. Selection uses actual native GetProviders with constrained generic provider-manager dependency stub and actual native exception handling.',
    normalization: 'No native output changed. The host execution test additionally applies native RefreshWithProviders suppression of remote providers during ValidationOnly without replacement; raw selected/checks remain recorded.',
  },
  integration: {
    test: 'tests/storage/probe-lifecycle.test.js',
    media: 'Synthetic PCM WAV of 0.1 then 0.2 seconds and synthetic external LRC/TXT only. Actual ffprobe reads private VFS HTTP leases.',
    storage: 'New in-memory SQLite; private independent PostgreSQL schema; actual AList current-source binary with isolated PostgreSQL database and synthetic Local driver. No original AList data.db or media opened.',
    return: 'Exported native-schema SQLite with lyrics and after removal. Actual Microsoft.Data.Sqlite Mode=ReadOnly + BaseItemMapper.DeserializeBaseItem and MediaStreamRepository.Map read exported fields; all three storage modes exactly equal recorded expected fields.',
    http: 'Two database queued POST Items/{Id}/Refresh integration with actual library/host/probe/VFS; authentication dependency is a stub. Existing metadata refresh HTTP native binding fixture covers the endpoint query/status contract.',
    timestamp: 'Actual AList exposed RFC3339 nanosecond/offset date persistence failure. Host and probe now normalize UTC preserving 100 ns; precision-boundary regression covers offsets and 9-digit fractions.',
  },
  commands: [
    'node tests/storage/fixtures/probe-lifecycle/create-input.mjs',
    '.tools/dotnet/dotnet.exe run --project tests/storage/fixtures/probe-lifecycle/Oracle.csproj -- tests/storage/fixtures/probe-lifecycle/input.json tests/storage/fixtures/probe-lifecycle/native.json',
    '.tools/dotnet/dotnet.exe run --project tests/storage/fixtures/probe-lifecycle/Oracle.csproj -- select tests/storage/fixtures/probe-lifecycle/selection.json',
    'Set MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_ALIST_EXECUTABLE and a new MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE directory; node --test tests/storage/probe-lifecycle.test.js',
    'node tests/storage/fixtures/probe-lifecycle/verify-native.mjs .test-input/evidence/image-hls-lifecycle-20260926/probe/verified',
  ],
  limits: ['ATL-exclusive tags, embedded lyrics extraction and complete audio parsing remain unsupported.', 'DVD/BluRay/ISO/shortcut probing and Book archive/PDF/EPUB remain unsupported.', 'No filesystem watcher/full scan scheduler or all Before/After refresh events are implemented.', 'Native mapper return is not a full native server media-access migration proof.', 'Internal metadata sidecars need explicit VFS mapping. Native .strm and subtitle download providers remain unsupported.', 'AList has no reliable object version; same-path sidecar byte changes alone do not trigger native change monitoring. Explicit full refresh bypasses cache. AList actual runtime uses PostgreSQL; CGO/SQLite backend remains unverified.'],
};
await writeFile(path.join(fixture, 'provenance.json'), JSON.stringify(provenance, null, 2));
for (const name of [...artifacts, 'provenance.json']) await copyFile(path.join(fixture, name), path.join(evidence, name));
console.log(JSON.stringify({ changeCases: 37, selectionCases: 90, sources: sourceHashes.length, currentMatchesFrozen: true }));
