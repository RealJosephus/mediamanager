# Native internal folder child caches

Fourteen controls warm actual AggregateFolder/UserRootFolder Children through EF-seeded child rows, modify/add child rows, and call actual BeforeMetadataRefresh, RequiresRefresh, ReleaseCachedChildren or the Children setter before reading again. GetItemById deliberately delegates to actual repository RetrieveItem; this does not prove the separate LibraryManager item-object cache. Captures the base child array and private ID-cache distinction, including stale-name replay and newly discovered children.

The candidate retains loaded children separately from their IDs and reuses the actual SQL-backed library state in the control. Releasing loaded children alone keeps IDs; AggregateFolder null assignment invalidates both, while UserRootFolder null assignment invalidates the base array only.

The original recorder remains candidateVerified=false. The candidate replays the declared projection through actual context/hooks and SQLite/real PostgreSQL. These controls do not establish full JSON/scalar bytes, complete physical-media resolution, network snapshots, ValidateChildren, production monitor/post-scan tasks or complete-library/release acceptance.
