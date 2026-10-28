# Production-cardinality whole-instance state exchange

This independent test clones the same-run initialized designated Native
instance and uses the existing large-catalog Native EF Oracle to generate
exactly 100,000 Movie, ancestry and user-state rows. It retains the complete
instance roots, original identity, native schema/history and all other tables.
The enclosing test keeps the original 900-second deadline, 128-row exchange
pages and 30-second production selector allowance.

Node imports into an isolated production PG schema, changes the current
catalog, replaces an unknown plugin file and removes another owned file.
The complete state package performs the only SQLite export; the test does
not export a second bare database before packaging. The same generation also
contains one independently served, durable conditional HTTP plugin-state
object with original opaque bytes. Both source server processes close normally,
and a restarted owner must expose the exact captured source version and bytes.
A separate HTTP target restores the packaged object, preserves an external
replacement instead of overwriting it, and verifies an idempotent retry.
The first call uses the full `restoreRemoteStatePackage` entry point; follow-up
remote-only conflict/reuse checks use `restoreRemoteAssets` with that same
immutable manifest instead of rescanning the unrelated 100,000-item SQLite file.
This controlled backend and fixture SDK adapter do not certify hosted
WebDAV/AList reliable-version behavior.

The shared real state-package worker reaches the bound database-opened restore
preparation, then is deliberately killed while it owns the actual SQLite file.
Its complete binding and database remain on disk. A distinct new process must
recover those exact owned files, complete the same package generation and
close normally. Every local instance asset is compared byte for byte before
consumers restart; only the production configuration's explicit root fields
are projected. All 31 tables and six insertion-order streams compare against
the current PG generation in the restored path representation. Raw TEXT,
unknown fields, Int64/100ns values, complete history and sequence high-water
marks retain the shared exchange contract. The original PG and instance
generation are independently reread after all consumers finish.

Native EF then verifies Node's changes and continues the restored catalog.
The actual full Native service starts from that same recovered instance,
authenticates with its original token, returns a bounded catalog page and
consumes one explicitly declared physical media item through its real
directory, playback-info, original-file and Range endpoints. The item's
transport bytes are an unchanged copy of the frozen source identified in
`input.json`; no encoding or recording runs. Full Native-host side effects
are captured only after normal shutdown and imported into a fresh PG schema.
Fresh and cold PG reads compare every table and relation stream, plus the
continued catalog selection and user state. PlaybackInfo can refresh the
physical item's missing stream metadata and persist its newly derived sort
name. Before shutdown the same Native host supplies another bounded filtered
page and retained-item detail; exact HTTP bytes remain recorded, with Int64
tokens parsed losslessly for the explicit comparison fields. Fresh PG uses
this post-probe observation, while every pre-probe EF and HTTP assertion
remains separate and unchanged. Its public SortName comparison uses the actual
production typed `mapRecord` hydration and `metadataSortName` getter with the
restored instance's real server configuration. That computed DTO value can
differ from the stored EF column (numeric chunks are padded for the public
getter); both observations remain in the report. The original stored column
is still covered by every complete 31-table/six-stream byte digest. No shadow
sort algorithm or additional Node runtime is introduced. Actual commands, process outcomes,
HTTP bodies/headers, asset hashes, phase timings and cleanup remain in reports.
The initial real SQLite snapshot retains its first and cursor-page SQL and
bindings for UserData and AncestorIds. Plain EXPLAIN QUERY PLAN records both
the executed source-qualified ordering and the previous raw-output-alias
ordering without replaying the slow query. These plans are diagnostic only;
complete values and every original fresh read remain the functional checks.
The exact catalog input and both original Native EF JSON byte sequences are
retained as base64 with their lengths and hashes before parsing or comparison.
Those component observations contain the declared catalog values and public
user identity, without the full host's authentication token.
Unexpected worker death or emergency termination, and any nonclean Native
shutdown, remain sticky cleanup failures. Only the explicitly proved restore
preparation death is intentional; emergency cleanup cannot qualify as normal
owner closure or permit removal of the private instance tree.

Successful `productionScaleVerified` and `fullInstanceVerified` apply only to
this declared generated catalog and whole-state recovery with actual Native
host consumption. `completeLibraryVerified`, phase and release flags remain
false. The other generated media paths are not materialized: this test does
not establish a 100,000-file scan, reachability of every catalog item, decoding
or a user production instance. Existing tests retain their own independent
scope and are not used to fill missing results in this test.
