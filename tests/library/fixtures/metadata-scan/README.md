# Native metadata traversal recording

`Program.cs` runs the pinned Jellyfin assemblies with the actual private
`Folder.RefreshMetadataRecursive` entry point, actual `Series` and `MusicAlbum`
container methods, `BaseItem.RefreshMetadata`, and the actual
`LimitedConcurrencyLibraryScheduler` configured with fanout one.

The 14 input scenarios record refresh order and options, root-only linked
children, old virtual episode filtering, album mode promotion, manual artist
lookup, path filtering, nonrecursive containers, cancellation and per-child
failure logging. Unexpected callback errors terminate recording; explicit
injected I/O and cancellation errors remain in the native log projection.

Repository child arrays, linked item lookup, artist lookup and single-item
provider results are controlled callbacks. All media paths use a synthetic
non-file protocol. Physical reconciliation, owned files, metadata providers,
NFO/image writes, artist creation and top-level library configuration are
outside this oracle's evidence boundary. The candidate separately exercises
real SQLite/PostgreSQL and ffprobe in `folder-metadata-scan.test.js`.

`provenance.json` seals the project, source, build properties, input and raw
native JSON bytes. Native output retains Windows CRLF. The oracle does not assert candidate
compatibility itself.
