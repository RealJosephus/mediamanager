# Series lifecycle native controls

`Program.cs` executes the pinned modified Jellyfin DLL's `SeriesMetadataService`
After hook and None refresh. Its real entities perform recursive and linked
traversal, episode/season filtering, native sorting, numbering from paths,
season identity calculation, `Folder.AddChild`, and new-season refresh defaults.
The creation projection uses the real `BaseItemMapper`.

The 92 controls cover obsolete virtual episode/season removal, numbered/unknown/
negative/special season creation, physical path comparisons, grouping key/season
reference synchronization, season pre-refresh with None mode, linked traversal,
foreign linked seasons, channel retrieval failure, empty presentation keys,
native ancestor/inherited-tag getters, and partial results after
update/create/delete/refresh failure or cancellation.
Stored entities explicitly use the mapper's minimum DateLastMediaAdded default.

Repository result filtering, cached children, localization text, empty providers,
library options and individual update/create/delete operations are controlled.
New-season `RefreshSingleItem` is also controlled; it records the actual native
default options and can fail after creation. The recorded `persisted` projection
advances only on successful controlled saves and removes only explicitly deleted
items. It is not an EF or native database snapshot. Unsaved cached entities are
recorded separately as `items`.

Candidate tests compare call order, creation mapper fields, valid ancestors,
inherited tags and committed entity
fields on SQLite and real PostgreSQL, including partial failure state. Separate
candidate integration tests run the new Season's actual metadata host, assert
events and AncestorIds, inject SQL deletion failure, and retain linked targets.
The shared deletion persistence retains the prior TMDB native EF evidence.

This recording does not execute native SQL, source-file deletion, internal or
external metadata directory cleanup, NFO, TMDB requests, alternate versions,
channel episode retrieval, a complete library scan or Web client flows. Those
require independent evidence; no release or P5 acceptance is claimed here.

Record into a fresh isolated directory:

```powershell
node tools/validation/oracle.js tests/metadata/fixtures/series-lifecycle/Oracle.csproj D:/isolated-validation/results/series-lifecycle-oracle-NEW tests/metadata/fixtures/series-lifecycle/input.json '{output}/native.json'
```

Apply the isolated validation environment first. `provenance.json` seals raw
input/output/oracle/project/build-property bytes, pinned source and runtime hashes.
