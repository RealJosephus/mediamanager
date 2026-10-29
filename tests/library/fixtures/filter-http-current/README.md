# Current Native filter HTTP consumers

This is a new execution identity: `same-workflow-current-native-filter-http`.
Each consumer uses the current GitHub Actions Native build and its independently
initialized, stopped instance. It records two private clones during the same test
invocation. Historical recordings are never used as expected responses here.

The existing neutral JSON inputs and their complete request matrices are retained.
`audio-input.json` is an exact recovery of the missing Static Audio neutral input:
SHA-256 `ce88db7c19e262d371e36e63f8f7fb3541242151d481458999d4720cab9257db`.
Its original declared location was
`D:/mediamanager-validation/20261011/filter-results/static-audio-source-input-v1/input.json`.
The recovery applies only the originally declared `alpha` Movie-to-Audio changes
to `rating-permissions/input.json`, with the original serialization bytes.

| Scenario | Cases per execution | HTTP responses per execution |
| --- | ---: | ---: |
| classification | 24 | 48 |
| extra-placeholder | 18 | 36 |
| image-type | 20 | 40 |
| navigation-date | 20 | 40 |
| official-ratings | 17 | 34 |
| official-rating-range | 20 | 40 |
| rating-permissions | 12 | 36 |
| tags | 17 | 34 |
| tag-permissions | 16 | 48 |
| static-source-permissions | 8 | 8 |
| static-audio-source | 8 | 8 |

The eleven HTTP consumers exercise 180 cases and 372 candidate requests. Their
two Native executions exercise 360 cases and 744 requests per platform. The
separate Static Audio input-integrity file retains five rejection cases; the
Tags file retains its query-binder regression case.

`current-profile.json` binds 18 current source/input files. The same contract is
used by all twelve test files, including the shared image/rating neutral inputs.
`currentNativeReference` verifies the executing build's source offer, complete
runtime, initializer, stopped seed and actual dotnet/FFmpeg/FFprobe dispatch
inputs before and after use. The recorder additionally binds 28 relevant Native
source files, the fixture, recorder, request matrix and exact launch arguments.

Each private capture retains the complete Native JSON response bodies, statuses,
content types, routes, scope/permission inputs, requested/effective policy
readbacks, selected persistent rows and relationships, complete database read
gates, FK/integrity observations, shutdown result, released PID/port/database
ownership and unchanged source inputs. Policy GET readbacks are included in the
same complete-database read boundary as the detail request. Complete candidate
DTOs, ordered results, counts, pagination, metadata, media-source flags,
permission outcomes, SQL read stability, filesystem/user-data stability and
cleanup assertions remain in the consumers.

Only the actual initializer user and existing aggregate-root IDs are projected
to their explicitly declared neutral IDs. Raw observations and the exact mapping
are retained separately. All other response fields are compared. Server IDs and
problem trace IDs retain their existing independent validity checks. No CLR
exception name, private object layout or fixed Native table/task count is a
cross-runtime acceptance condition. Synthetic persisted type names are seed
format data and source bindings, not a JavaScript implementation requirement.

Native templates are read from each private clone; the candidate receives the
captured template rows and verifies the source database hash. The supplied
stopped instance is never opened directly through a read-only SQLite connection
by these consumers, so SQLite WAL side files cannot mutate a shared input.

The current input also binds the actual Native startup administrator's complete
public policy, independently of a newly created user's defaults. Node persists
that same policy and reloads it before the original per-case policy updates.
Synthetic item and image path inputs use the current stopped instance's host
path root and are passed unchanged to both consumers. The paths remain offline
synthetic media identities; no source-instance file is created or changed. Both
Native repetitions use the same declared paths. Complete `CanDelete`,
`MediaSources.Name`, path and permission response fields remain compared.

After each Native execution, the private post-authentication database baseline
is restored only after clean shutdown. Read mutations are checked for every
actual request batch before that restoration. The private database and credentials
are removed; public evidence contains reports and logs, with credential values
hashed by `createPrivateFilterOutput`. `private-cleanup.json` records that boundary.
Each scenario also saves both current Native receipts, the complete candidate
observation and a complete HTTP comparison report.

The nine existing `*/provenance.json` files and the three historical
`native-query-inputs` bindings retain their original bytes and identities. Their
declared DLL/build/recording receipts are missing at their original paths; current
files are not used to satisfy those seals. Current execution does not import
those historical profiles. Historical replay remains
available through the original recorder and evidence-reader tools when all its
original inputs are supplied.

Validation is GitHub Actions only. This implementation has received static
review and input organization locally; no local candidate test, syntax check,
preflight, validation runner or build has been executed. Component or release
acceptance must be established from the final committed Actions candidate and
its complete TAP, registration, schema-3 input receipts and PostgreSQL cleanup.
Static source declarations cover permission flags, not encoding capability or
playback negotiation. Capture reports do not claim release acceptance.
# Native task isolation

The stopped private clone clears its plugin repositories and writes empty trigger
files for the actual scheduled tasks discovered in the same-run sealed source.
The task definitions, source hashes and configuration hashes are retained in
`isolation-preparation.json`. The real configuration, task and network HTTP
readbacks must confirm the isolation before the complete database baseline.
Native startup work must become idle within the bounded wait. No initializer
input or shared instance is changed.

# Read failure diagnostics and initialization ownership

Every case still compares the complete database, including all tables,
schema/column/index/FK descriptions, sequences, pragmas and integrity checks.
The equality input and its SHA are unchanged by diagnostics. The summary now
retains each table's row SHA/count and structure SHA before and after every
actual request batch, plus the complete baseline, stopped after-run and restored
snapshot summaries. When a read gate fails, at most 64 changed rows and 256
changed cells retain table/column names and exact primary-key, row and cell
fingerprints. Arbitrary TEXT/Data, credentials, blobs and keys remain hash-only.
Only explicit SQL timestamp columns with valid timestamp values can expose
their timestamps; unknown JSON members are not traversed or rewritten. The
private already-read rows supply these diagnostics without a second scan or
new database mutation.

Run `40520156687`, candidate `75c68f1`, failed classification at its twentieth
case, `status-numeric-unknown`, after 40 actual HTTP responses. Selected fixture
rows remained stable; the complete database SHA changed. Native then exited
with code zero and released its PID, port and database, and the original
baseline was restored. That original summary contains no per-table before/after
differences, so it cannot establish which table or value changed. The original
result remains failed. The actual authentication/session/device source bindings
are retained for interpreting new diagnostics; an activity-stamp hypothesis is
not recorded as an established cause or used to remove a table from the gate.

The classification file now registers its file resource and teardown
synchronously, and performs both Native captures in a protected `before` hook.
An initialization error cannot abort module evaluation before teardown exists.
The existing file owner waits for the actual callback/finally work to settle,
then releases only its own token. An independent process regression makes the
initialization hook fail while it holds an actual listener/file, proves the
lease remains held during cleanup, then proves both owners close and a real
successor acquires a fresh token. No stale receipt is reclaimed or ignored.

Recorder cleanup retains the original error followed by ordered cleanup errors.
It records actual PID/port/database release, keeps the private tree when Native
ownership remains open, and never calls forced termination a clean shutdown.
The real request matrices, two repetitions, complete body comparisons and all
database stability/restoration assertions remain mandatory.

The other ten current filter callers use the same synchronously registered file
owner and protected initialization/candidate callbacks. Their existing matrices,
permission readbacks, complete responses, cold/read/shutdown state and cleanup
checks remain intact. Static Audio additionally retains its own current recorder
binding; that binding and the enclosing current profile track this recorder's
actual new bytes. Historical recordings, source provenance and neutral input
files retain their original identities.

