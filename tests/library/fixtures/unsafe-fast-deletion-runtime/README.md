# Same-platform UnsafeFast batch recording

This recorder derives from the preserved
[`unsafe-fast-deletion/Program.cs`](../unsafe-fast-deletion/Program.cs). It keeps
the same thirteen real `LibraryManager.DeleteItemsUnsafeFast` cases, SQLite
persistence, `PathManager`, external cleanup, cache observations and explicitly
controlled collaborators. `input.json` supplies the case order to both C# and
the Node consumer. The old recorder, raw output and provenance remain unchanged.

The current Actions runner builds the isolated project against that run's sealed
Jellyfin runtime. `record.json` binds the project sources, SDK, native executable
and output; `native.json` records the input SHA, actual platform and loaded
assembly hashes. SQLite is loaded from the current SDK RID's native assets.
Each case closes its SQLite contexts, resets surviving read-only attributes and
proves an exclusive database-file open before reporting release.

Both implementations set the actual filesystem read-only state and observe its
real deletion result. Windows and POSIX outcomes are compared with their own
native run; permissions failures are never simulated. Candidate setup consumes
only native pre-action rows and file hashes. Comparison retains every persisted
column, relations, directory/file hashes, ordered external/persistence/Removed
calls, warmed cache behavior, independent retention-clock bounds and temporary
SQL cleanup. Candidate receipts are written before the main differential
assertions. The existing 1000-item success and 257-item late-preparation failure
tests remain unchanged.

This fixture covers the original Genre/Studio/Folder batch controls. Its Video
descendant tests persistence closure, not root Video media-source preparation.
The latter requires a separate actual native scenario and is not claimed here.
