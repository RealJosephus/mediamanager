# Music genre post-scan maintenance

`Program.cs` executes the designated `MusicGenresPostScanTask` and
`MusicGenresValidator`, actual `BaseItemRepository.GetMusicGenreNames`,
`LibraryManager` identity and lookup, EF SQLite persistence and directory
creation. `input.json` supplies seventeen independent scenarios. Application
paths, recording state, lookup/refresh failures and the metadata provider are
explicit controls. No media source or port is opened.

The recording verifies the four exact repository source types (Audio,
MusicVideo, MusicAlbum and MusicArtist), grouped minimum display names,
relation-only membership and AudioBook exclusion. Initial MusicGenre IDs are
captured before any callback. A new case-colliding identity is therefore
refreshed twice if absent from the initial set, while an initially existing
identity skips both refreshes. Per-name failures retain creation prefixes;
cancellation propagates from lookup or refresh. An initially cancelled token
does not stop an all-existing or empty task, and does not prevent a new genre
from being created before refresh observes cancellation. Empty names are
accepted. Owned and alternate initial entities do not enter the default ID
query baseline.

Candidate comparisons use the original constructor/source rows, ItemValues
and maps as inputs. They compare lookup/Added/refresh order, default options,
progress, cancellation and persisted genre identity/name. Separate Node
runtime coverage verifies actual metadata persistence, curated existing data
and no repeat refresh invocation. A PostgreSQL case uses 12,000 unrelated
rows, including 1,000 initial genres, plus 225 mapped names; it requires
bounded hydration and scalar pages of 128 and 97 rows. Source and initial-ID
snapshots remain in SQL. The selected SQLite grouping order is represented
with the database's ordinal text order for stable callback prefixes.

`native.json` is the original recording without newline normalization.
`provenance.json` binds its bytes, input, C#/project/shared build properties,
designated source copies, SDK, runtime SQLite artifact and managed assemblies.
Failed build/runtime attempts are preserved in separate evidence directories.
Re-record with `tools/validation/oracle.js` into a fresh isolated directory.

This fixture does not establish complete native metadata-provider behavior,
all default post-scan tasks, a directory watcher, full library scanning, a
complete build-input closure or final release acceptance. Runtime registration
adds this task while `runsPostScanTasks` and `completeLibraryScan` remain false
until the remaining required implementations are verified.
