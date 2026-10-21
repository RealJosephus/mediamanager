# Guide image cache evidence

`live-tv-guide-images.test.js` executes this workflow's designated native DLLs,
with source bindings and assembly SHA-256 receipts. The C# oracle reflects the
actual private `GuideManager.PreCacheImages` and calls the actual
`LibraryManager.ConvertImageToLocal`, native `BaseItem.SetImagePath`,
`UpdateToRepositoryAsync`, and the native LiveTvProgram/LiveTvChannel internal
metadata path overrides. It sets the actual private parallel options to one
worker for deterministic traces and records the unchanged native CPU/10 default.
The synchronous native build/run recorder executes in the owned fixture worker,
so the test thread continues serving HttpClient requests. The receipt requires
exactly one worker message, a zero exit code, and completed thread shutdown.

The SD daily-limit sequence is controlled, with no Schedules Direct account or
provider execution. `IProviderManager.SaveImage` is a declared controlled
boundary: it uses a real HttpClient against the test's loopback HTTP server,
writes the returned PNG, and attaches it through native SetImagePath. The native
repository save is a declared trace-only boundary; it opens no business DB and
does not claim to exercise native ImageSaver or the SQLite repository. HTTP 403,
404 and 500 responses are real. The selected cases cover strict 100ns EndDate,
null EndDate, filtering before ID distinctness, repeated slots, the unusual SD
All predicate (including empty/local/SD/mixed images), its worker and per-image
rechecks, alternative URL retry, per-image failure continuation, fixed image index
zero, live image aliases after independent repository saves, and malformed
collection/path observation only at the actual consumption boundary.

The Node side uses PostgreSQL-owned typed cohorts, real MetadataImages download
and saveRemote, the real MetadataUpdateHost and persistence functions, actual
LibraryService/ItemCreationService, and a real LiveTvChannel parent. No conversion
callback replaces production conversion. Metadata bytes go through
MetadataImageAssets and StorageFileSystem backed by the local storage plugin's
explicit isolated test mapping. The test reads bytes back through that mapping
and checks PostgreSQL image rows and BaseItems. Current typed slot state is kept
in PostgreSQL; filtering and first eligible Guid identity stay SQL-side. Scalar
state projections carry invalid image predicates without throwing at capture.
Each Node transfer contains at most 128 slots/entities. Separate tests exercise
131 unique programs plus a repeated slot, close during a held real HTTP request,
and a real PostgreSQL constraint failure after the mapped file write. Close stops
new work and later images while draining the current no-request-token conversion
before image/storage/database owners close. All cohort references are released.

The native oracle's controlled repository has no database validation for malformed
rows; malformed-path cases therefore stop before conversion, rather than claiming
cross-database invalid-row persistence. This is component evidence, not a complete
Guide refresh or final release acceptance. No local execution is authorized;
Windows/Linux/macOS Actions produce the raw receipts and comparison report.
