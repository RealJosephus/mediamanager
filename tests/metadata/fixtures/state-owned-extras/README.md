# Instance-owned Playlist and BoxSet extras

This fixture executes actual pinned Jellyfin `BaseItem.RefreshMetadata`/`RefreshExtras`, `LibraryManager.FindExtras`, DotIgnore/CoreResolutionIgnoreRule, native file enumeration/resolution, cached metadata fields, missing deletion and ItemPersistenceService/EF SQLite. Production ports use the repository's GPL-2.0-only license. `provenance.json` seals selected clean-pin sources, actual DLL/runtime bytes, SDK/driver/project/input and two independent v4/v5 recordings. The recordings are byte-identical. `native.json` has its own checkout-byte seal.

There are 14 cases each for Playlist and BoxSet: XML-only/default and full refresh, new trailer/audio, nested extras, stable/renamed/locked names, missing trailer, cancelled new/missing, empty ignore, ancestor ignore and nearest UTF-16 override. The provider, collection lookup, source manager and other external collaborators are controlled. The native single-item provider records dispatch and deliberately performs no save; this is not a complete MetadataService/probe/provider/save oracle.

Each recording publishes the complete pre-refresh BaseItems and metadata-field frame. Candidate PostgreSQL tests seed this initial state (never final expected rows), preserve physical parent and owner constraints, and compare every selected final column, complete Data, links, state file hashes, cached lookup names, parent cache flags, dispatch, events and cancellation. Only isolated root spelling and fresh creation dates are normalized. Both implementations independently compare fresh DateCreated with the actual file birth date at 100 ns and constrain it to the current sample lifetime before normalization. Persisted dates, locked fields, separators in persisted paths, file hashes and ordering are not normalized away.

Instance directory and .ignore observations use only explicitly configured state roots. External .ignore ancestors require a separate known network namespace; missing mappings remain incomplete and cannot authorize deletion. Preview caches are isolated. Extra media access uses per-item VFS bindings, never a state-root media prefix or host-byte fallback. Native state files are 16-byte neutral controls; the separate runtime host cases deliberately expose different network metadata to prove the first provider save uses the binding.

Separate real PostgreSQL host tests verify initial save/events, unknown ignore ancestors, missing-row/internal-extracted cleanup before cancellation, retained remote sources, cancelled creation, SQL insert failure, and D3 ignore appearance. Actual isolated rclone WebDAV tests exercise both owner types, changed source dates before first insert, and missing cleanup with byte-for-byte retained network sources. Extracted-data invalidation shares persistence's absent-row/owner/relationship baseline; stale owners, competing rows and missing creation intent/frame cannot authorize any cleanup. A cleanup SQL failure retains the earlier file-removal prefix but prevents first insert. Production runtime tests also refresh physically parented Playlist/BoxSet XML directories. Reader tests cover date precision, missing/partial enumeration, narrow .ignore delegation, BOM/preview caches and junction escape rejection.

Re-record into a new isolated output directory, using the DLL directory declared in provenance:

```powershell
$env:MEDIAMANAGER_DOTNET='D:/mediamanager/.tools/dotnet/dotnet.exe'
$env:MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY='D:/isolated/pinned-dll'
$env:TZ='Asia/Taipei'
node tools/validation/oracle.js tests/metadata/fixtures/state-owned-extras/Oracle.csproj D:/isolated/new-output D:/mediamanager/tests/metadata/fixtures/state-owned-extras/input.json '{output}/native.raw.json' '{output}/state'
```

The DLL directory must include `e_sqlite3.dll` at its root. The project excludes any previous Oracle DLL from references. Dirty LibraryManager changes observed during this stage are ResolvePaths logging; dirty Folder changes are child-refresh/progress, outside the controlled owned wrapper path. Selected clean source and DLL seals do not close the full designated dirty-reference build input closure. POSIX native recording, complete MetadataService/probe/scanner/network/client/exchange and final release acceptance remain unverified; `candidateVerified=false` is intentional.
