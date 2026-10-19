# Native general media-item deletion

This fixture runs the actual pinned `LibraryManager.DeleteItem` and real EF
SQLite persistence for 105 scenes. It covers `Audio`, `AudioBook`, `Book`,
`Movie`, `MusicVideo`, `Video`, `Episode` and `Trailer` source-capable leaves,
plus DB-only `Series`, `Season`, `BoxSet`, `LiveTvProgram`, `MusicAlbum`,
`Photo` and `PhotoAlbum`; internal `Person`, `Genre`, `MusicGenre`, `Studio`,
`Year` and by-name `MusicArtist`; and physical `MusicArtist` folders. File
leaves use `BaseItem.GetDeletePaths`.
Movie, MusicVideo, Video and Trailer use `Video.GetDeletePaths`: a non-mixed video
deletes its containing directory, while a mixed video deletes its file and prefixed
sidecars. `Episode.GetDeletePaths` always selects its own file; only a mixed Episode
also selects sidecars. Episode and Trailer directory-disc shapes remain withheld
by the production preflight because this fixture covers their `VideoFile` shapes.

All 105 scenes define candidate parity. They freeze DB-only deletion, exact-file
and containing-directory source deletion, already-missing files, all eight types, shortcut and virtual
items, channel provider success/`ArgumentException`/failure/suppression, mixed
DB-only deletion, the absence of a cancellation token, and source/external/SQL
failure prefixes. Mixed-folder deletion covers all 21 native sidecar extensions,
case-insensitive Unicode filename prefixes, empty stems, a source also selected
as a sidecar, and nonrecursive enumeration. Direct files keep the VFS enumeration
order; folders and unsupported extensions survive. Enumeration must materialize
completely before the required file is deleted. Both complete and partial
enumeration failures happen after internal cleanup and retain the source and DB.
An optional sidecar I/O failure retains that file while later sidecars and
persistence continue. Internal metadata is removed before the required source; live
`ParentId` is detached before external cleanup; persistence, cache invalidation,
parent cache invalidation and `Removed` follow in that order. The default overload
selects `GetOwner() ?? GetParent()` for the event and cache invalidation; an
explicitly supplied parent remains authoritative. A failed source
retains external data, database, live parent and events. An external failure
retains the database after source deletion and live detachment. A later SQL
failure retains every prior file cleanup and detachment.

The container cases cover both DB-only retention and requested source deletion.
Series, Season, MusicAlbum and PhotoAlbum delete their mapped source directory;
LiveTvProgram and Photo delete the exact file, and a mixed Photo uses the shared
native sidecar rules. A managed BoxSet deletes only its instance directory below
`data/collections`; a different state root and the shared collections root are
rejected before side effects. Series, MusicAlbum and PhotoAlbum carry real direct
children through recursive cleanup, and a source-deleted Series proves that the
child source remains while external cleanup and `Removed` stay child-before-parent.
Missing folder/file sources continue state deletion; required source, external and
SQL failures retain the native committed prefix.

All six by-name cases delete their instance metadata directory even when
`DeleteFileLocation` is false, after the per-ID internal metadata directory and
before external cleanup. Candidate containment is stricter than native's string
prefix: the path must remain below the exact type root and can never equal that
shared root. Physical MusicArtist covers DB-only retention, requested recursive
source deletion and a real Audio child closure.

Owned `Audio`, `AudioBook` and `Book` targets cover explicit-parent deletion,
default `GetOwner()` event/cache parent selection, and requested source deletion.
The `Audio` ownership and malformed non-folder `ParentId` scenes also preserve
the native persistence-only closure: descendant rows and warm cache entries are
removed without deleting their files, cleaning their metadata, or publishing
their own `Removed` events. A stored non-Video `PrimaryVersionId` is ignored as
the native CLR type has no video-version lifecycle, and the referenced row is
retained. A mutable live `IsVirtualItem` value likewise follows the native live
object and does not rewrite the persisted source identity. `candidate-differences.json`
therefore has no withheld oracle scene. No compatibility alias or legacy path is added.

The external provider is controlled in the native oracle and candidate and uses
one equivalent fixture-owned marker directory. Its call, failure prefix and
presence are compared; this does not claim complete external-provider cleanup.
The candidate additionally verifies readonly and mount-root ID bindings,
complete weak listings, optional permission errors versus protocol failures,
mount directories hiding sidecars, and ID-only aliases with the original media
filename. These adapter controls do not claim a real AList/WebDAV recording.

The two latest native captures are byte-exact, and all prior 102 results remain
unchanged. `provenance.json` binds source, input, DLLs, runtime, capture and replay.
Every relevant specified-workspace source matches the pin after line-ending
normalization except one extra `ResolvePaths` debug-log line in `LibraryManager`,
outside the deletion dependency chain; that exact difference is recorded.

Candidate comparison includes every projected final DB row, all media files,
failure prefixes and parent/cache state. The owned Trailer and ordinary owned-file
cases have an Audio owner supplied by the fixture and cover explicit Folder parent
and default owner priority, with a Movie default-parent scene as well. The two
closure scenes prove only the pinned persistence cascade and do not stand for a
complete owned-extra or version family. Removed IDs, parent IDs and phase state
are compared along with every other projected call. Focused strict results and
their scope are bound in `provenance.json`; this does not establish full-profile
or release acceptance.

The oracle must use the clean pinned checkout at
`208c278b75abd897aefa1e1175126eac5e4dbfaa` and its Release output. Re-record into
a new isolated directory:

```powershell
$env:MEDIAMANAGER_DOTNET = 'D:\mediamanager\.tools\dotnet\dotnet.exe'
$env:MEDIAMANAGER_JELLYFIN_DLL = 'D:\mediamanager-validation\20261008\jellyfin-pinned-208c278\source\Jellyfin.Server\bin\Release\net10.0\jellyfin.dll'
$env:MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY = 'D:\mediamanager-validation\20261008\jellyfin-pinned-208c278\source\Jellyfin.Server\bin\Release\net10.0'
node tools/validation/oracle.js tests/library/fixtures/general-leaf-deletion/Oracle.csproj D:/mediamanager-validation/20261008/results/general-leaf-deletion-rerun tests/library/fixtures/general-leaf-deletion/input.json '{output}/native.json' '{output}/state'
```

Focused dual-store verification:

```powershell
$env:MEDIAMANAGER_TEST_POSTGRES = 'postgresql://validation@127.0.0.1:15439/postgres'
node --test tests/library/general-leaf-deletion.test.js
node --test tests/library/item-deletion-service.test.js tests/library/directory-video-delete-items.test.js tests/library/general-leaf-deletion.test.js
```
