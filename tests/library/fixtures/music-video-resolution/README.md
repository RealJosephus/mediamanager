# Native MusicVideo resolution and first validation

This pack contains 92 scenarios recorded directly against the frozen Jellyfin
assemblies. Separate cases invoke `LibraryManager.ResolvePaths` and the protected
`Folder.ValidateChildrenInternal` boundary with recursion and child metadata
refresh disabled. MovieResolver and FolderResolver are the registered resolvers.

The cases cover raw MusicVideo names and years, file stacks and local editions,
strongly enumerated directory collapse and Folder fallback, supplied input order,
Unicode prefix matching, ignore rules, provider tokens and directory precedence,
inherited locks, configured DateAdded, actual AggregateFolder ancestry, every
ordinary 3D format and its token boundaries, repeated validation, cancellation,
and real primary, alternate and link insertion failures.

The recording preserves all 72 BaseItems columns, complete raw and parsed Data,
relationships, created-item lookup, resolver dispatch, files, cache and events.
Resolve-time dates were asserted inside the native UTC capture window before
being normalized to `$UTC_RESOLVE`. Read JSON with the lossless parser so that
CLR Int64 values remain exact.

`input.json`, `Program.cs`, `Oracle.csproj`, and `native.json` are raw sealed
recording files. Do not reformat or normalize them. Provenance identifies their
hashes, frozen source identity, capture output, and controlled collaborators. The
initial 82 results preserve every original field value in
the expanded recording; the initial source and output are retained externally.

This pack verifies ordinary MusicVideo resolution and nonrecursive first
validation on real SQLite and PostgreSQL. Provider savers, collection membership,
media sources and the known ancestor namespace are controlled. It does not
establish recursive existing-item validation, disc or stream resolution, complete
MetadataService, production full scan, network storage, Web clients, migration,
or final release acceptance.
