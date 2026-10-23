# Current password reset HTTP and persistence consumers

This fixture preserves all 88 original scenarios: 83 HTTP scenarios with 84
requests and five direct `UserManager.UpdateUserAsync` snapshot scenarios. It
executes two independent builds and processes against the workflow's designated
Native runtime. Historical fixtures and the separate current PIN-file consumer
remain unchanged.

The Native execution uses actual controllers, MVC binding and authorization,
`UserManager`, default reset/authentication providers, cryptography, EF SQLite
and physical files. The principal, network classifier and event subscribers are
controlled. Snapshot outcome codes describe the direct operation, not an HTTP
response. The platform SQLite library comes from the same designated build and
is copied for the current SDK RID.

Each scenario records the complete Users, Permissions, Preferences,
AccessSchedules and ImageInfos tables before and after the operation. The Node
test imports the current Native initial rows into an isolated PostgreSQL schema
and uses production user/password services and HTTP routes. It checks complete
row values, request results, provider catalogs, PIN files, password-change events
and committed effects after write, transaction, event or deletion failure.
Stale snapshots, relation rebuilding, provider fallback and malformed-file
behavior retain their original inputs and observations.

Both Native runs must agree before either can supply expectations. Random PINs
are bound to generated files and requested passwords; expiration times must
match actual request windows and paths must belong to their observed instance.
Synthetic password hashes retain their required format and are verified with
the original password and requested PIN before randomness is projected. Node
also verifies the Native initial hashes cryptographically. All five-table
values, unknown fields, public errors and ordered events remain observable.
Public JSON compares complete parsed values and Allow compares method sets.
Trace IDs retain their required presence but are per-request identities.

Current output retains raw request inputs, responses, exact PIN-file bytes,
each Native SQLite database, source/build/runtime receipts, independent-repeat
projections and candidate observations. File inventory order is diagnostic;
redemption order and partial commits are checked through public events,
returned users and persisted rows. Internal call traces remain diagnostic.
Generated test PINs and synthetic hashes
are evidence; live credentials and authentication tokens are not recorded.

Required services are `dotnet`, `jellyfinDll` and `postgres`. This is current
Native HTTP/component and real candidate persistence evidence. It does not
establish a full Native instance, complete state-package/database exchange,
phase completion or release acceptance. The independent existing runtime and
public PIN-file reader regressions remain relevant. All test, build and check
execution belongs to Windows, Linux and macOS GitHub Actions.
