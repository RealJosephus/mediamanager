# Collection repository selection

This fixture runs the actual designated `LibraryManager.GetItemList`, `AggregateFolder.Children`, `BaseItemRepository`, mapper and SQLite database. Application path reversal is an identity control; the manager's collection-folder navigation seam returns an empty list. It opens no media or listener and does not run CollectionManager, metadata saving, HTTP or a scan lifecycle.

The 23 Movie queries cover physical ancestors, cached and empty CollectionFolder physical IDs, UserView display parents and numeric enum conversion, PlaylistsFolder as an ICollectionFolder, BoxSet and Playlist links, nested containers, cycles, linked folders, non-folder alternate links, default owned/alternate exclusions, duplicate presentation keys, raw typed Data fallback, offsets and the 1000-row page before collection-name and PrimaryVersionId gates. A folder captured first as a link owner cannot later add its closure; PostgreSQL preserves the native breadth-first visited state. Unknown display targets and unknown parent context stop typed lookup and retain the original ancestor fallback. Explicit null PhysicalFolderIds fails. Guid.Empty remains a non-null PrimaryVersionId. Roots use actual default repository order and skip unknown native types. Initial BoxSet order is recorded independently.

`input.json` is independent fixture input. `native.json` contains raw 72-column SQLite rows, AncestorIds and LinkedChildren, root objects, query results and loaded assembly hashes. `provenance.json` binds raw output, oracle inputs and executable, 15 designated sources and their matching build copies, and 19 loaded Jellyfin assemblies. Complete build-input closure and phase acceptance remain false. PG tests import the raw rows and compare source projections; a separate 20,000-row test freezes the Movie page in SQL and returns one count row to Node.

Record into a new isolated directory with the declared validation environment:

```powershell
node tools/compat/record-collection-source.mjs D:/isolated-validation/new-collection-source/native
```

Preserve failed runs and old recordings. A new recording must be rebound before replacing the fixture. Root options, mutable task groups and initial names belong to their independent owners; this source module does not establish production task admission, membership saving or shutdown behavior.
