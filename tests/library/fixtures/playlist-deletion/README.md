# Playlist deletion oracle

This fixture executes actual Jellyfin `LibraryManager.DeleteItem`, `Playlist.LoadChildren`, `BaseItem.GetDeletePaths`, repository hydration and `ItemPersistenceService` over isolated Windows files and real EF/SQLite persistence. Jellyfin-derived production behavior is GPL-2.0-only. `provenance.json` binds the clean source pin, selected source bytes, input, driver, project, shared build properties, this README, loaded DLLs and two independent raw recordings.

The 30 neutral cases cover managed and external files/directories, all five playlist suffixes, absent sources, database-only deletion, linked members, Parent/Owner persistence closure, cold/warm owned Video, explicitly cached logical children, null/physical parent controls, notification and caller cancellation, file cleanup and SQL failure prefixes. Initial rows retain all 72 columns and unmodified Data, initial links and file hashes before any deletion. Final rows/Data, links, file hashes, per-phase observations, cache lookups and events remain observable. A cold persistence-only row is not pre-hydrated. An already warm owned Video remains cached after its row is removed: native DeleteItem evicts logical items, not the separate persistence closure.

Application-path reversal/expansion, provider collaborators and the extracted-data cleanup marker are controls. The actual file-system failures use exclusive Windows file handles; the SQL failure uses an actual SQLite trigger. The candidate uses a separate PostgreSQL trigger and mapped VFS media, never a host-media fallback. The native API is synchronous and has no cancellation argument; the cancelled-caller case records its unchanged behavior, not native cancellation support. DateCreated and other dates are fixed neutral inputs, not normalized candidate outputs.

Independent v3/v4 native recordings are byte-identical. To repeat, select a new isolated output directory and the sealed DLL directory from provenance:

```powershell
& .tools/dotnet/dotnet.exe run --project tests/library/fixtures/playlist-deletion/Oracle.csproj -c Release -p:JellyfinDllDirectory=D:/isolated/pinned-dll -p:BaseOutputPath=D:/isolated/new-run/bin/ -p:BaseIntermediateOutputPath=D:/isolated/new-run/obj/ -- tests/library/fixtures/playlist-deletion/input.json D:/isolated/new-run/native.raw.json D:/isolated/new-run/state
```

Separate candidate tests exercise Items/{id} Playlist HTTP ownership/visibility, API keys, actual configured physical-parent user cleanup, queued XML completion, state-root/junction/D3 guards and actual rclone WebDAV deletion. Those are not native HTTP or PlaylistManager user-cleanup recordings. Selected clean sources plus loaded DLL seals do not close the dirty reference checkout's build inputs. This does not prove a full metadata/provider/scan run, generic batch HTTP deletion, POSIX behavior, native-instance exchange, two-Web or final release acceptance. `candidateVerified=false` is intentional.
