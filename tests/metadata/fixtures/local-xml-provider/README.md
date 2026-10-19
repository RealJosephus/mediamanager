# Collection and playlist local XML oracle

This fixture calls the actual pinned Jellyfin local XML parsers/providers and BoxSet/Playlist metadata merge methods. Jellyfin-derived production behavior uses the repository's GPL-2.0-only license. `provenance.json` binds selected clean source bytes, loaded assemblies, the driver/project/input, and independent v9/v10 recordings. Their raw output is byte-identical; `native.json` adds a final newline and has its own seal.

There are 46 neutral parser inputs for each of BoxSet and Playlist (92 results), 10 provider cases, 6 BoxSet merge cases and 5 three-call merge pipelines. The cases retain exact XML names, external-ID registry lookup, CLR trim, dates with 100 ns precision, Single numeric values, enums, people, tags, studios, links, shares and owner parsing. Malformed XML records partial assignments, look-ahead and subtree commit boundaries. Self-closing and explicit empty containers differ. Cancellation is observed in outer parser traversal, not file lookup or subtree traversal. DTDs are prohibited. XML declarations do not override the UTF-8/BOM TextReader.

Provider cases use actual `ManagedFileSystem` and `DirectoryService`: a path with an extension can still be a directory, missing XML returns no item, post-read XML errors propagate, and `HasChanged` uses a strict timestamp comparison without a one-second threshold. The external-ID registry and library/configuration responses are controlled. Numeric oracle projection widens Single to Double to retain its exact value; only the fresh MinValue DateCreated Kind is normalized in candidate projection. Parsed dates are not normalized away.

Pipeline cases reproduce the actual local merge, existing-metadata merge and final target merge with native flags. Default refresh replaces Playlist links and retains source duplicates. A non-replacing refresh can keep both raw-path and cached-ID keys for the same eventual member. BoxSet always concatenates source first and deduplicates, even when replacing. Internal DataPath children retain repository-owned links. XML owner/OpenAccess are not merged.

Candidate tests separately exercise production PostgreSQL/runtime and an actual isolated rclone WebDAV service. Logical directories write only `playlist.xml`; they are not overwritten as playlist files. XML savers resolve known ItemIds in a fresh bounded SQL batch; raw XML Path/LibraryItemId resolution occurs later in the repository, matching the native order. The original state-local integration deliberately uses a standalone item with no ParentId to isolate XML/merge/save. Later production tests add physically parented Playlist/BoxSet XML refresh; the separate `state-owned-extras` fixture freezes directory observation and selected owned lifecycle cases. This XML fixture does not claim a complete managed Playlist lifecycle or local media backend.

Repeat the native recording in a new isolated output directory using the sealed DLL directory from provenance:

```powershell
& .tools/dotnet/dotnet.exe run --project tests/metadata/fixtures/local-xml-provider/Oracle.csproj -c Release -p:JellyfinDllDirectory=D:/isolated/pinned-dll -p:BaseOutputPath=D:/isolated/new-run/bin/ -p:BaseIntermediateOutputPath=D:/isolated/new-run/obj/ -- tests/metadata/fixtures/local-xml-provider/input.json D:/isolated/new-run/native.raw.json D:/isolated/new-run/state
```

These recordings do not execute a complete native MetadataService refresh, native repository persistence or full dirty-reference build closure. Full XML grammar/encoding/numeric edge matrices, POSIX native recording, owned state-local discovery (covered separately), full scan, HTTP/two-client, instance exchange and release acceptance remain outside this fixture. `candidateVerified=false` is intentional.
