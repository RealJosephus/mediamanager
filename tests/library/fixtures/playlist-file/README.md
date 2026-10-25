# External playlist file oracle

This fixture executes the actual pinned Jellyfin `PlaylistManager` and PlaylistsNET 1.4.1. Jellyfin-derived production behavior is licensed under the repository's GPL-2.0-only license. `provenance.json` binds the pin, selected source bytes, input, C# driver, project, loaded assemblies and independent raw recordings.

There are 34 writes, 51 Windows `Uri.MakeRelativeUri` path cases and 12 public mutation cases. Exact bytes include UTF-8 without BOM, CRLF, M3U final trim, PLS field order and WPL/ZPL attribute escaping. Duplicate and unresolved links, artist interfaces, null fields, Int32 duration saturation, malformed paths, percent escapes and XML errors remain observable. Mutation recordings retain committed/live state, the bytes before each repository call and after each queued ForceSave, repository failure and first/second/third synchronous file-write failure. The native input is neutral and does not come from candidate expectations.

`ILibraryManager` lookup and repository responses and `IProviderManager.QueueRefresh` are controlled. These are actual manager/file calls, not native SQLite persistence, full saver/image execution or refresh completion. The candidate's PostgreSQL foreign key cannot hold a missing lookup, so the five-format persistence tests omit that unresolved link while retaining the identical resolved output. Separate tests cover production runtime XML/image/repository wiring, a partial HTTP boundary and actual isolated rclone WebDAV reads/writes/read-only/failure behavior; Memory VFS alone is not network evidence.

The independent v5/v6 raw recordings are byte-identical. Their paths and seals are in provenance. To repeat the native run, select a new output directory and use the sealed DLL directory from provenance:

```powershell
& .tools/dotnet/dotnet.exe run --project tests/library/fixtures/playlist-file/Oracle.csproj -c Release -p:JellyfinDllDirectory=D:/isolated/pinned-dll -p:BaseOutputPath=D:/isolated/new-run/bin/ -p:BaseIntermediateOutputPath=D:/isolated/new-run/obj/ -- tests/library/fixtures/playlist-file/input.json D:/isolated/new-run/native.raw.json D:/isolated/new-run/state
```

This is not a complete build-input closure, POSIX native recording, external logical-directory/deletion lifecycle, full library scan, native instance exchange, two-Web or release-acceptance claim. `candidateVerified=false` is intentional.
