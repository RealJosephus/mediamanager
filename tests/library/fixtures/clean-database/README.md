# Database cleanup post-scan oracle

The 28 cases execute the designated `CleanDatabaseScheduledTask`, actual
`LibraryManager.DeleteItem`, `BaseItemRepository`, `ItemPersistenceService`,
`PathManager`, SQLite and the managed filesystem. Each case has independently
recorded initial and final 72-column item rows, item values and mappings,
directory/file hashes, progress, calls and failures. The source output bytes
are copied unchanged from the isolated recording; provenance binds inputs,
oracle source, assemblies and the specified dirty reference source files.

The media-source services expose File protocol, empty streams/attachments and
no media segments. Metadata refresh, channel providers and production mounts
are outside this oracle. A synchronous SynchronizationContext observes the
actual nested Progress callbacks deterministically; wall-clock scheduling is
not asserted. The manager's external cleanup uses the real path/files phase
with other external managers unconnected. No media stream or listener opens.

Cases include empty work, two dead names, a video, existing/missing playlists,
arbitrary/no/trailing extensions, directory/null/empty paths, nested playlists,
frozen dead membership, cancellation and selection/lookup/path/deletion/value
transaction failures. Node replays the recorded initial state using PostgreSQL
and instance metadata directories; media identities use a writable VFS fixture
and never access the host media directory. Native CLR exception names and
provider diagnostics are retained as observations; comparison projects them
only after identifying the same failure boundary.

These cases are component evidence. They do not establish full post-scan,
metadata, watcher or release acceptance.
