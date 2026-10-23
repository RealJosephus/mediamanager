# Current playlist file consumers

This fixture executes the workflow's designated Native build. It retains all 36
original provider inputs, 24 layout inputs and 15 merge inputs as neutral data.
Their historical source files, responses and provenance remain unchanged. The
literal historical absolute-path input remains present; an additional declared
`$MEDIA` input exercises a real current absolute path and a file absent from the
controlled item lookup.

The actual `PlaylistItemsProvider`, `PlaylistMetadataService.MergeData` and
`BaseItemMapper` run over current files. Node compares success or failure,
metadata, ordered duplicate links, share permissions, all database columns and
every parsed `Data` field and value. Complete serialized `Data` text, exception
details, encoding diagnostics and lookup calls are retained as observations.

Nine new writer cases cover M3U, M3U8, PLS, WPL and ZPL, including reordered XML
attributes and BOM/LF variants. Node creates actual files through its production
playlist serializer. Native consumes the exact bytes, rewrites through
`PlaylistManager.SavePlaylistFile`, and reads the result again. Both providers
read the files; the Native format readers compare paths, member order,
duplicates, titles, albums, artists and durations from both writers. Original
and rewritten file bytes are retained in the current output.

Library roots and item lookups are controlled. PostgreSQL supplies Node's real
ordered member store. This is file-consumer and mapper evidence, not a Native
repository transaction, actual HTTP instance, complete library exchange or
release acceptance. Required services are `dotnet`, `jellyfinDll` and `postgres`.
All execution belongs to the three GitHub Actions platforms.
