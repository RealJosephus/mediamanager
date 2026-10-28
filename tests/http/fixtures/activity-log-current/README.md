# Current ActivityLog HTTP consumer

[`activity-log-native.test.js`](../../activity-log-native.test.js) starts the
designated Jellyfin source build in an owned clone of the current workflow's
stopped Native instance. It calls the actual
`GET /System/ActivityLog/Entries` endpoint through its running HTTP host. The
controller, MVC binding, authorization, ActivityManager and SQLite provider are
real. Expected responses are recorded during that run, rather than loaded from
a historical response recording or a replacement action host.

The source receipt binds ActivityLogController, ActivityManager, the query/DTO
and public enums, RequestHelpers, nullable enum binding and registration,
authorization handlers, and the database entity/date converter to the executing
build's source manifest. The common Native reference helper verifies that the
supplied stopped instance and source build remain unchanged after the fixture.
Private clone configuration and database controls do not change those inputs.

Real Native HTTP APIs create an ordinary account and a userless API key. After
the preparation host stops, the fixture inserts twelve explicit activity rows
and 132 bounded generated rows into its real migrated SQLite schema. They cover
real users, an empty user ID, a missing user, null/empty optional strings,
non-ASCII text, wildcard characters, case-sensitive opaque item strings,
unknown numeric severities and adjacent 100ns dates. These are controlled GET
inputs; this fixture does not claim that ActivityManager produced those rows.
Startup activity is removed only from the owned clone after host startup, so
unfiltered counts and default paging use the same fixed input on both runtimes.

One stopped SQLite database is frozen before the Native request matrix. The
same complete database is then imported into a fresh PostgreSQL schema, with
the imported digest checked against SQLite. The production Node entry point
starts with explicit storage mappings and repeats the requests with the same
identities, credentials, query values and persisted activity rows.

[`input.json`](input.json) defines the requests and bounded row controls. The
matrix covers authorization before binding; administrator and userless API-key
access; unknown fields; nullable and repeated scalar values; invalid/overflow
integers, booleans, GUIDs and dates; default, zero, negative and large limits;
negative/beyond-end offsets; and finite results crossing 128 rows. Filters cover
name, overview, short overview, type, username through the left join, user-ID
presence, exact item ID, severity, inclusive dates and one-tick windows.

Sorting covers every exposed field, the public spelling `Overiew`, the missing
numeric enum member, ascending/descending combinations, repeated values,
numeric values, sequential/named indexes and index gaps. These parameters use
the controller's actual MVC array binding. A comma inside one enum value is
converted as an OR-combined enum; it is not interpreted as a custom split-array
binder. The designated nullable severity binder ignores malformed text and
accepts unnamed Int32 values. HEAD/POST method selection, public error bodies,
and CamelCase/PascalCase JSON profiles are also observed through actual HTTP.
Every completed Native response is retained before reporting a declared input
expectation mismatch. The full candidate matrix still runs against those actual
observations; either kind of mismatch keeps the test failed. Transport failures
and changed persisted inputs still stop the scenario and retain its prefix.

The candidate keeps filtering, joining, sorting, counting and pagination in
PostgreSQL. A bounded response of at most 128 items can use an array. Larger or
unlimited results use a real cursor with serial reads of at most 128 rows and
JSON writes that await socket backpressure. The store/session remains owned
through response consumption and cursor cleanup. A negative public limit still
returns the complete selected result; the read batch size is not a result cap.

After the Native/Node matrix, a separate candidate lifecycle phase adds 13,000
valid, large activity rows directly to its owned PostgreSQL schema. Real TCP
consumers pause after receiving an item. One disconnects, after which a new
bounded HTTP query must succeed with the persisted count. Another remains slow
while the production runtime closes; its socket, listeners and port must be
released. This phase exercises backpressure, disconnect recovery and shutdown
ownership. It does not compare Native's private allocation strategy or require
a fixed SQL plan, query count, cursor representation or socket buffer size.

Reports retain complete response text, headers, byte counts and hashes, source
bindings, the imported input receipt, actual registered routes, activity
snapshots before/after reads and after shutdown, and real process/runtime/schema
cleanup. Comparisons retain public values, ordered results, counts, null/empty
distinctions, errors and all seven date tick digits. JSON layout, equivalent ISO
fractional zero spelling and Allow-set order follow the existing protocol
boundary. Request trace IDs remain opaque strings. CLR exception
types, stack traces, diagnostic log counts and internal framework objects do
not determine acceptance. Original observations are retained before these
comparison projections; credentials are filtered before publication.

Run in GitHub Actions with the current Native reference, stopped Native instance
and isolated PostgreSQL services. Resource leases cover the Native HTTP and
discovery resources through cleanup. Only filtered reports and logs are
published after owners close; private databases and credentials are removed.
The fixture verifies this read endpoint and its production ownership boundaries.
It does not establish log creation, WebSocket delivery, media scanning, full
instance migration, production scale or final release acceptance. A completed
implementation or dispatched workflow is not a recorded passing result.
