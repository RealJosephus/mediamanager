# Declared large catalog exchange

This fixture generates exactly 100,000 Movie rows, 100,000 ancestry rows, and
100,000 user-state rows in a private byte copy of the same-run initialized
Native SQLite database. Generation uses the designated Native EF model for
the template, schema column mapping, and transaction; SQLite expands only
those declared values. No audio/video bytes or media files are generated.

The production PostgreSQL item selector must return the full SQL count with
bounded 128-row hydration, including the favorite/year predicate, a deep page,
and an empty page. A 30-second SQL deadline retains the ordinary HTTP budget.
The empty-page observation also retains its actual EXPLAIN ANALYZE plan and
checks that the exhausted page never executes the complete item ordering.
The expected selection also comes from an independently executed actual Native
EF query, while Native streams every generated item through its real mapper
and checks all opaque Data strings.

Node uses the production database transaction API to insert, edit, and delete.
Complete export is checked against all native tables, schema, full migration
history, sequence high-water marks, and all six insertion-order streams before
Native starts a fresh continuation process. Native verifies Node's mutations,
continues metadata/user state, deletes Node's addition, and inserts a new item.
A fresh PG schema and cold connection must retain every native value and return
the same bounded selection. The original PG generation remains unchanged.

Both imports follow the existing production CLI order: create an isolated
target with runtime expression indexes deferred, transfer and verify every
native row, then initialize the complete runtime functions/indexes and verify
their stored schema fingerprint before any item query. No index is omitted.
The original 900-second test deadline remains in place. Cancellation reaches
each stage, transfer/export and bounded snapshot loop, and prevents later
success flags; clean resource teardown still runs after cancellation.

Performance diagnosis preserves every read and verification. Each stage records
its Node process CPU delta, memory and raw `resourceUsage` counters before/after;
these counters do not measure the independent PostgreSQL or Native process CPU,
and unsupported platform I/O counters can remain zero. The formerly unlabelled
complete exported-SQLite snapshot has its own stage. The observer aggregates
actual `rows`, `insertBatch`, insertion scans, PostgreSQL operation queries,
SQLite prepares and statement calls by phase/table; every runtime CREATE INDEX
has its own query-duration group. Nested call times are inclusive and must not
be summed as independent work. SQL, parameters, batch sizes, results, native
statement ownership and errors are forwarded unchanged; synchronous SQLite
calls remain synchronous and every wrapper is restored after owner cleanup.
No payload values or connection strings are copied into these aggregate metrics.

The declared dense tables contain 72 BaseItems fields, 2 AncestorIds fields and
13 UserData fields: approximately 8.7 million cells per complete 100k read,
alongside all remaining native tables and all six insertion streams. Direct
per-column row decoding avoids temporary key/value arrays while retaining the
original decoder, column order, consumer and complete field set. Digesting
reuses only immutable null/boolean canonical tuples; raw TEXT, blobs, integer
precision, canonical JSON bytes and all fresh digest passes remain exact.
Any performance improvement or remaining 900-second failure needs actual CI
results; these allocation changes do not establish a new acceptance result.

`productionScaleVerified` applies only to this declared CI-generated catalog
cardinality and these query/exchange operations. `completeLibraryVerified`,
`fullInstanceVerified`, and release/phase acceptance remain false. Physical media
reachability, a full scanner over 100,000 files, and a user's production instance
are separate from this fixture's evidence. The adjacent complete-instance test
supplies real scan/inventory/original-byte evidence for its smaller whole library.
