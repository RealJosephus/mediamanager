# Genre and Studio post-scan maintenance

`Program.cs` executes the designated `GenresPostScanTask`, `StudiosPostScanTask`
and validators, actual repository name queries, LibraryManager lookup/creation,
PathManager, ExternalDataManager, EF SQLite persistence and UnsafeFast file
deletion. `input.json` supplies 32 independent scenarios for both kinds. Metadata
providers and explicit lookup, refresh, external-data and database faults are
controls; no media source or port is opened.

The recording covers relation-only source membership and grouped minimum
display names. Genre excludes the four music repository types and includes
AudioBook; Studio accepts all mapped source types. Initial existing names use
OrdinalIgnoreCase and retain custom IDs. Those names and the initial ID set do
not grow when a lookup creates an identity, so new case or sanitized-path
collisions can refresh the same identity twice. Null initial names fail before
the loop. Empty and Unicode names, per-name failures, lookup/refresh cancellation
and complete progress prefixes are recorded. A renamed deterministic identity
is reused without refresh if its ID was initially selected; owned and alternate
identities are excluded from the default snapshots but remain available to the
typed lookup, which therefore refreshes them and observes cancellation.

Cleanup uses the global exact ItemValues.Value predicate and excludes locked
entities. Genre cleanup includes MusicGenre. An initially cancelled all-existing
or empty task still performs cleanup; cancellation observed by a lookup or
refresh stops before cleanup. Ordinary lookup/refresh failures continue to
cleanup. Preparation failure preserves every source, whereas later external or
SQL failures retain the recorded file prefix and leave persistent roots intact.

Candidate comparisons seed every one of the 72 pre-action BaseItems columns,
ItemValues, maps and filesystem entries independently of the results. They
compare complete output rows and relations, file digests, lookup/Added/refresh/
external/persist/Removed order, refresh defaults and progress. New timestamps
are checked against each runtime's actual directory creation/modification
observation at lookup before those timestamps are projected between instances.

Separate PostgreSQL scale cases keep 12,000 background rows, 1,000 initial
by-name entities and 225 source names in SQL, require pages of at most 128 rows,
and execute the full cleanup. Runtime coverage verifies registration order
Genres, MusicGenres, Studios, actual metadata persistence and no repeated
refresh on a second run. The recorded assembly type order and designated
ApplicationHost/LibraryManager sources bind that order for this task subset.

`native.json` retains its original bytes. `provenance.json` binds input,
recorder/project/shared build properties, designated source copies, SDK,
managed assemblies and the native SQLite runtime. Re-record with
`tools/validation/oracle.js` into a fresh isolated output directory.

These observations do not establish all default post-scan tasks, a directory
watcher, full library scanning, complete native metadata-provider behavior,
complete build-input closure, actual Web workflows or release acceptance.
