# Collection post-scan task

The 22 observations execute the designated `CollectionPostScanTask` DLL.
Root folders, repository results and CollectionManager are controlled by the
checked-in oracle; these observations do not prove native repository, SQLite,
metadata, files, HTTP or Web behavior. The observations were independently
recorded again in
`D:/mediamanager-validation/20261013-release-collection-scan-agent-native-1`.
The result bytes match the previous recording. Provenance binds the current
designated source, the matching isolated build source, the oracle inputs and
the managed DLL/JSON files in the configured reference build directory.

The candidate tests run all selection snapshots, first-name grouping, member
deduplication, initial mutable names and paging in a real PostgreSQL session.
Calls, progress and failure prefixes are compared against native observations.
Internal exception names and complete GUID formatting in diagnostic logs are
not functional assertions; their native observations remain unchanged.

The source adapter projects typed Movie Data only after the repository page.
The injected membership manager receives one SQL relation for each add. The
initial BoxSet relation has a mutable-name bridge, and creation does not extend
that relation. Candidate repository plans and the 257-root/257-group/2,050-member
case independently verify SQL filtering and bounded projections. A task admits
its manager dependency once, rejects new admission before requesting a database
session, and releases the admission after final progress and temporary relation
cleanup. An admitted task does not propagate a cancelled scan token to its
manager operations.

Production task registration is pending a collection manager and typed metadata
relationship persistence path that can consume one relational member operation
without loading an unbounded LinkedChildren list. Repeating finite add calls for
each SQL page would change saves, queued refreshes and events and is not an
acceptable replacement.

To record the actual task again, configure `MEDIAMANAGER_JELLYFIN_DLL` and
`MEDIAMANAGER_DOTNET`, then run:

```text
node tools/compat/record-collection-post-scan.mjs NEW_OUTPUT_DIRECTORY ISOLATED_BUILD_SOURCE DESIGNATED_SOURCE
```

The recorder requires all four task contract source files to match the
designated workspace and rejects source or build dependency changes during the
observation. It does not claim a complete build input closure.
