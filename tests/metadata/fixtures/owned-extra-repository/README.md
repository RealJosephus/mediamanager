# First repository save of discovered extras

This recording extends actual frozen FindExtras/RefreshExtras with a controlled
single-item provider that calls the actual `BaseItem/Video.UpdateToRepositoryAsync`,
`LibraryManager.UpdateItemsAsync` and `ItemPersistenceService` over real files and
EF SQLite. It deliberately omits MetadataService BeforeSave, probe and provider
merges; the owner provider does not save.

The 15 samples cover new Trailer/Video/Audio, rename and attached/full refresh,
first INSERT versus UPDATE failures, cancellation before refresh and during the
saver, retained marker files, and one failed extra alongside another committed
extra. Selected columns, including persisted ExtraType, complete Data, file
hashes, events and cached existing names are compared on real SQLite/PostgreSQL.
Native DateLastSaved is range checked; candidate supplied-clock values must match
the stored column and Data before normalization. Saver marker writes, images,
collection membership, media sources and extracted-file dispatch are controls.

The native controlled provider's calls complete synchronously. The candidate
comparison serializes only that controlled provider to reproduce its scheduling;
production owned tasks remain parallel and must all finish before the wrapper
returns, including failures. Separate production regressions test that boundary,
new extra refresh, live owner inheritance, writer preflight, weak snapshots,
concurrent rows/owners, cancellation, Audio deletion and ordinary directory
owner first saves/writer preflight. No trace fields, IDs,
Data or file assertions are dropped. This is scoped evidence, not complete
MetadataService, scalar mapper, .ignore/disc/network/scanner or release acceptance.
