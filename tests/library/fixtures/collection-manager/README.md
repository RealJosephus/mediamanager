# Collection manager core oracle

The 65 neutral controls call the pinned actual `CollectionManager` for collection
folder lookup, creation, member addition and removal. Actual `Folder.AddChild`,
linked-child resolution, `BaseItem.UpdateRatingToItems`, `LinkedChild.Create`,
`ManagedFileSystem` filename/path handling and real directory creation execute.
Legacy path lookups also call actual `LibraryManager.FindByPath` and its
`GetItemList` boundary; the captured query preserves default owned/alternate
exclusion, DateCreated descending and Limit=1. Repository selection for those
queries is controlled, so these controls do not claim actual native SQL execution.

Inputs cover ancestor and descendant root paths, a missing or unresolved
collection library, server-language naming, ignored ParentId/UserIds, filename
replacement, empty/null names, null provider IDs, duplicate members, dead/empty
IDs, a Folder-derived by-name artist with IsFolder=false, legacy
relative/absolute/single-backslash paths, rating locks, unknown and
empty ratings, case deduplication, stable ties and nullable subscores. Collection
events, saves, refresh queues, monitor calls and library creation have independent
failure controls. Creation retains its directory and created item after later
failures; the complete(false) finally boundary still runs. Removal retains the
first-link/object-identity distinction and saves/queues/emits even with no match.

Library roots and items, deterministic creation ID, repository saves, provider
execution, rating scores and library configuration are explicit controls. The
native output retains actual creation/modification timestamps; differential
comparisons use live fields, links, operation order, failure prefixes and directory
effects. The candidate runtime tests separately verify filesystem timestamps,
deterministic IDs, PostgreSQL relationships, actual XML savers and cold reopening.
Native persistence, metadata refresh, HTTP/authorization, task integration, Linux
instance execution and complete release acceptance remain separate work.

`provenance.json` binds all inputs/output and oracle sources, shared build
properties, actual loaded assembly hashes and the successful build/process
record. Every listed designated source file was checked byte-for-byte against
the isolated source copy that produced the loaded baseline. Failed builds and
earlier behavior captures remain in their separate isolated output directories.

The candidate selects root children in pages of 128 and linked ID batches of 128;
legacy Path candidate filtering, exclusion, ordering and Limit=1 remain in SQL.
An existing collection's typed live LinkedChildren array and metadata persistence
still materialize that collection's own relations. The post-scan relational member
plan and large-collection mutation contract are not claimed by this finite-request
core fixture. External declared DataPath and junction rejection have separate
candidate state-boundary tests.

With the isolated validation environment configured, collect into a fresh output:

```powershell
node tools/validation/oracle.js tests/library/fixtures/collection-manager/Oracle.csproj D:/mediamanager-validation/new-collection-manager tests/library/fixtures/collection-manager/input.json '{output}/states' '{output}/native.json'
```

Refresh fixture hashes and preserve the actual loaded-assembly/source binding
when changing the oracle or input. Public JSON/path-root comparisons preserve
consumer values while substituting each run's real isolated root and controlled
creation identity; raw native bytes remain unchanged in the fixture.
