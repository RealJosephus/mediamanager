# Native directory item deletion

Forty-one scenes run the actual frozen LibraryManager ResolvePaths, CreateItems and
DeleteItem, with real EF SQLite persistence and files. All 72 mapped columns,
full Data, original resolved/dispatch/row/link/file/cache/event/lookup fields,
AncestorIds and BaseItemProviders are retained. All previous thirty-five native
result objects are unchanged. The first thirty-five parity scenes pass candidate
comparisons on real SQLite and PostgreSQL; the final six are deliberately asymmetric
native safety counterexamples and are not claimed as candidate parity.

Ordinary Movie/Folder and file-stack retention, two/three-version primary
promotion, missing-first/all alternate cleanup, alternate deletion, actual
source-directory deletion, recursive logical Folder descendants and descendant
SQL faults, channel source-delete suppression, null parent and notify=false are
recorded. Direct DVD/Blu-ray deletion covers Movie, MusicVideo and Video resolved
respectively from nested `VIDEO_TS`+VOB, `BDMV`, and direct `video_ts.ifo`.
`DeleteFileLocation=false` retains the complete source tree. With source deletion,
a direct disc returns its Path as the one required directory, while a multi-disc
item returns the primary disc's parent once; `AdditionalParts` are not individually
deleted. The outer directory, its sidecars, and every disc disappear while a sibling
outside that directory remains.

The six additional scenes mutate `Data.VideoType` and the already-loaded live
`VideoType` independently after `CreateItems`. Direct and multi-disc layouts each
cover persisted/live `Dvd`/`VideoFile`, `VideoFile`/`Dvd`, and `Dvd`/`BluRay`.
Native deletion consults only the mutable live value: in the direct persisted-DVD,
live-VideoFile case it derives the discovery parent and deletes `Keep/sentinel.txt`
and the sibling `primary.mkv`. Production deliberately fails closed whenever either
side is DVD/Blu-ray but the two types are not identical. Its dual-store tests prove
that rejection precedes DB, cache, event, internal/external metadata and media-tree
side effects.

Real phase snapshots freeze internal metadata cleanup, the required source attempt,
live Parent detachment, external cleanup, EF deletion, cache eviction and Removed
event order. Missing sources continue through the state deletion. A Windows
read-only file throws `UnauthorizedAccessException` and an exclusive lock throws
`IOException`; real recursive deletion may already have removed unblocked children,
while the DB row, cache, Parent and event remain untouched. A later injected EF
delete failure proves source/internal/external cleanup and live Parent detachment
are not compensated. All markers and media trees stay inside the verified sample
root. Native UTC-window dates are normalized after assertions; candidates use the
supplied clock.

Pinned `LibraryManager.cs:558-624,667-679,725-754` binds the ordering and type
boundary: every item removes its internal metadata before the required source
attempt, but only `Video` contributes trickplay/chapter/subtitle/attachment paths
to that early cleanup. The two Folder source-failure scenes therefore retain all
extracted-data markers while the internal metadata subtree is gone. Existing Video
failure scenes continue to prove those extracted paths are removed before the same
`IOException`/`UnauthorizedAccessException` boundary.

MovieResolver/FolderResolver, empty metadata saver/provider and collection
dispatch, empty media-source/channel-static-source dispatch, and
DeleteFromExternalProvider=false are explicit controls. The separate production
tests exercise real NFO save/SQL fault boundaries, ID-bound source access,
read-only mounts, source deletion failure and preflight scope guards.

The generic deletion entry point supports the recorded ordinary Movie/Folder and
isolated direct/multi-disc lifecycle. It validates the persisted disc shape before
any side effect, including live/persisted equality for mixed-folder, owner,
primary-version and channel state. It resolves one authoritative ID-bound VFS target and rejects
read-only mounts before cleanup. Owned deletion closures and incoming/outgoing
version families remain fail-closed before source or metadata changes. ISO,
shortcut/placeholder sources, other native item types, mixed-folder source sidecar
deletion, child MetadataService, external channel deletion, broader owned/version
disc semantics, source migration, full scan/client/performance and release
acceptance remain outside this fixture's scope.

## Independent regression reproduction

The independent review used the real PostgreSQL validation service:

```powershell
$env:MEDIAMANAGER_TEST_POSTGRES = 'postgresql://validation@127.0.0.1:15439/postgres'
```

Partition 1 is the following exact 11-file command and passed 866/866 with no
failures or skips:

```powershell
node --test tests/library/directory-item-resolver.test.js tests/library/directory-item-scan.test.js tests/library/directory-multi-disc-stack.test.js tests/library/directory-native-validation.test.js tests/library/directory-video-create-items.test.js tests/library/directory-video-resolution.test.js tests/library/music-video-resolution.test.js tests/library/nested-movie-resolver.test.js tests/library/resolved-item-scan.test.js tests/library/video-file-resolver.test.js tests/library/video-stack-resolver.test.js
```

Partition 2 is the following exact 13-file command and passed 626/626 with no
failures or skips:

```powershell
node --test tests/library/folder-remote-linked-replacement.test.js tests/library/folder-scan-linked-references.test.js tests/library/linked-child-reference-service.test.js tests/library/local-alternate-scan.test.js tests/library/media-versions.test.js tests/library/owned-extra-scan.test.js tests/library/owned-part-scan.test.js tests/library/video-extras-resolver.test.js tests/library/video-version-discovery.test.js tests/library/video-version-ignore.test.js tests/library/video-version-relations.test.js tests/metadata/external-data.test.js tests/metadata/file-before-save.test.js
```

These are new, independently rerun and reproducible partitions. They replace the
earlier local 502/502 and 582/582 summaries; they do not present those older counts
as if the reviewer had reproduced them.
