# Native batch deletion observations

`Program.cs` executes the designated dirty runtime's actual
`LibraryManager.DeleteItemsUnsafeFast`, `PathManager`, `ExternalDataManager`,
`ItemPersistenceService`, EF SQLite repository, managed filesystem and cache.
Application paths, path reversal, collection membership, selected static
collaborators and two injected service failures are explicit controls.

The 13 cases retain independent complete pre-action rows, directory/file hashes,
ordered external/persistence/Removed calls and post-action rows. They cover empty
batches, kept/deleted sources, whole-batch null-path preparation, late external
failure, service/database failure, real Windows read-only files, event parent
lookup, root-by-root cache eviction, recursive Parent/Owner persistence closure,
two Ancestor expansion levels, retained user data and untouched descendant files
and warm entities. Scalar GUID/date/bigint projections preserve every column.
The retention clock is verified against each implementation's clock before a
diagnostic marker comparison. Result rows are never candidate seed inputs.

`provenance.json` seals raw recording and recorder bytes, captured assemblies and
designated source bindings. The native run does not open media or network ports.
Complete native build-input closure, all video/source shapes, production scans,
HTTP/authentication, POSIX, clients and final release acceptance remain outside
this recording.
