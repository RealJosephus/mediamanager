# Current native metadata HTTP and files

The current native instance discovers UserRoot through GET /Items/Root. A
private stopped clone then receives controlled CollectionFolder, UserView and
Playlist rows, actual media files, NFO and managed playlist XML. Media occupies
its own private sibling directory; instance discovery retains its strict
top-level state layout. Both state and media reset before candidate execution. Aggregate,
UserRoot and PlaylistsFolder keep their observed native identities. Library A
retains its two existing IDs; its physical files are created inside the clone.

The actual native HTTP server executes the three original edit requests for
each of the six internal types. After shutdown, the private instance is reset
to the initial byte snapshot at the same physical paths. All native SQLite
tables and history are imported into PostgreSQL, and the production Node HTTP,
authentication, metadata savers, local storage plugin and repository execute
the identical requests. No source instance or reference checkout is modified.

The comparison checks complete BaseItems columns, eleven relation tables,
responses, filesystem entries, file contents, and stable shutdown state. Save timestamps
must fall inside their own actual request interval and Data clocks must agree
with the corresponding column. Generated ItemValues IDs require unique exact
semantic rows and consistent map references. Initial state and files are exact.
After an edit, AggregateFolder's getter-only VirtualChildren cache is compared
as empty: native JSON deserialization does not restore that process cache.
The rewritten movie NFO and managed playlist XML retain element order, attributes,
leaf text, unknown extensions and empty-container syntax. Their reader contracts
allow indentation/line endings, empty NFO studio/art, and playlist LockedFields
order with exact membership and multiplicity. Other files remain byte-exact.
Source bindings include the actual native entity and both XML readers; all raw
rows, file text, byte sizes and hashes remain in the reports.
Only reports and redacted process logs leave the private instance directory.
