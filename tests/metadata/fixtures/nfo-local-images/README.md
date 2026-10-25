# NFO local-image filesystem oracle

This fixture executes the pinned Jellyfin `MovieNfoParser` against real per-scene files and directories on Windows. Its runtime-source scene also enters through actual `BaseNfoProvider`/`BaseVideoNfoProvider` result creation. It uses the production `ManagedFileSystem` and `DirectoryService`; a thin delegating probe records the literal `GetFile` argument and injects only the two explicitly named deterministic failure/cancellation boundaries.

The 212 scenes freeze:

- absolute and drive-relative Windows paths, forward- and backslash UNC forms, incomplete and device UNC forms, missing files, directories, relative paths and invalid absolute URIs;
- accepted Windows `file:` URI forms retain the original NFO string for `DirectoryService.GetFile`: zero/one-root drive paths, two-or-more slash/backslash roots, drive/host/UNC forms, empty roots, legacy `C|` forms and query/fragment suffixes; relative, single-root server, incomplete drive and encoded-drive forms are rejected without lookup;
- `System.Uri` acceptance before image classification: authority-required `http`/`https`/`ftp`/`gopher`/`ws` forms without `//` and authority backslashes are rejected, a backslash inside an HTTP path becomes `/`, while valid custom, `urn`, `mailto` and `data` opaque URIs remain remote;
- `System.Uri.ToString()` remote rendering: hierarchical authority, nonempty and explicitly empty userinfo/password delimiters, IPv6 compression/default ports, opaque paths and explicit empty query/fragment delimiters; malformed percent sequences, raw and escaped display-safe ASCII, reserved/control escapes and valid or excluded UTF-8 are frozen separately for path, opaque, query, fragment and userinfo components;
- IRI decoding is component-specific: RFC `ucschar` values display decoded in all covered URI text components, `iprivate` additionally displays decoded in query, and C1, replacement, surrogate/invalid UTF-8 and noncharacters remain escaped; userinfo preserves standalone display-only escapes but displays them when that component also has a percent-encoded unreserved or `ucschar` anchor, while reserved delimiters remain escaped;
- independent one-per-`ImageType` local and remote lists, all seven NFO image mappings, dotted-aspect exclusion and ordinal case-sensitive aspect matching;
- pre-populated local and remote image lists, flat `thumb`, and the first descendant `fanart/thumb` behavior;
- fresh runtime provider `Images`/`RemoteImages` creation even when the caller already has image state;
- malformed-XML look-ahead, deterministic `IOException` prefix retention, pre-cancellation and cancellation after the first real filesystem lookup.

`native.json` records normalized `$ROOT`/`$ROOT_URI` paths while every scene still creates and queries its real temporary filesystem entries. The native run is bound to Windows 10.0.26300, `zh-CN`, Asia/Taipei, Jellyfin commit `208c278b75abd897aefa1e1175126eac5e4dbfaa`, the listed source files, the built assemblies and the oracle record in `provenance.json`.

The production comparison additionally resolves an existing `//server/share/...` image through a real `VirtualFileSystem` and `IdentityAccessMap`, including `ReplaceAllImages` and `ReplaceImages` with an old Primary image. A mapped runtime control mounts `/images`, maps `D:\library` to it, loads `D:\library\movie.mkv`, and proves that `file:C:/missing.jpg` remains a literal native lookup: it is neither decoded nor submitted to the ordinary identity map, and a missing value leaves `HasMetadata=true` with no image. The same real assets keep ordinary invalid or unmapped Windows/UNC identities fail-closed. Scenes 59–132 are imported unchanged from the independent 74-scene review input (`95a9ffad28129e627643e2b74af11e5dc9352fb3bb2841e42b06d7d69f1fdb31`); its native result was `690c1537d552597bc764474646ce3166d7261e0c0d19a6e25f7171df2202145d`. The remaining component and `file:` URI controls were then recorded through the same pinned DLL. The evidence is deliberately platform-scoped. It does not claim Unix `System.Uri` behavior, reachable network-share contents, reparse/ACL/path-length races, URI/NLS/XML cases outside the declared matrix, post-parse filesystem races, non-Movie parsers, or downstream persistence beyond the focused import. The deterministic I/O exceptions are injected at the directory-service seam; they are not evidence for a particular Windows ACL failure.

Recording command:

```powershell
$env:MEDIAMANAGER_DOTNET='D:/mediamanager/.tools/dotnet/dotnet.exe'
$env:MEDIAMANAGER_DOTNET_ROOT='D:/mediamanager/.tools/dotnet'
$env:MEDIAMANAGER_JELLYFIN_DLL='D:/mediamanager-validation/20261005/jellyfin-baseline/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'
node tools/validation/oracle.js tests/metadata/fixtures/nfo-local-images/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-local-images-20261008-v11-literal-identity tests/metadata/fixtures/nfo-local-images/input.json '{output}/native.json' '{output}/filesystem'
```

The repository copy is LF-terminated with a final newline. `candidateVerified=false` remains intentional: this focused fixture closes only the local-image reader slice and is not a claim that the complete NFO reader or release is accepted.
