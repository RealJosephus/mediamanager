# Session and playback activity from real hosts

This Actions-only differential starts the designated same-run Native full host
in a private clone. Native HTTP creates two ordinary users, an API key and an
empty library. After actual host shutdown, five finite media rows are inserted
into its genuine migrated SQLite schema. They retain a seventh fractional date
digit, real parent/ancestor relations, Audio/Video/Book kinds and theme ExtraType
8/9. A complete stopped SQLite baseline is frozen before the business matrix.
The production Node entry point later imports that exact baseline into fresh
PostgreSQL; it does not import the Native matrix's mutated database.

`neutral-input.log` preserves the original `input.json` bytes, including line
endings. Its SHA is retained in the report and provenance. All HTTP responses,
committed activity rows, user playback rows, identity bindings, WS frames and
partial actions remain in the credential-filtered observations. Dynamic tokens
are first consumed against real HTTP and bound to the same runtime's stored
Device/User rows. Session IDs come from actual authentication/session responses
and are used against real additional-user endpoints. No generated-ID shape,
replacement ID, or cross-runtime session-ID equality is required.

The 18 declared actions include real session creation, same-session reuse,
additional users, logout, relogin and same-device reauthentication. Playback
cycles separately record their actual start, progress and stop requests. They
cover supplied Audio/Video/Book `MediaInfo`, series names and the first artist,
first-user activity ownership with both users' persisted playback state, theme
media exclusion, null `MediaInfo`, and supplied external media with no library
item. Proper named MediaType values are used. This fixture does not claim to
exercise every nested DTO binding spelling.
Reuse goes through the real `Sessions/Capabilities/Full` endpoint and its
`GetSessionId`/`LogSessionActivity` chain; a listing alone is not treated as a
session-creation/reuse producer.

The API-key session has no primary User. It shares the player's actual DeviceId
while retaining a separate user-qualified session identity. API-key authorization
uses the same runtime's stored `ApiKeys.Name` as the public `Session.Client`,
including when the original request supplies a different Client header. Every
cycle phase checks that identity in the actual Sessions HTTP and WS consumers;
the additional-user request checks its actual Sessions HTTP readback. Its cycles run both
before and after attaching a real additional user. Native `GetUsers` returns
early for an empty primary user, so neither cycle may change those users'
playback rows. The player's later real logout ends both device sessions; only
the named user's session qualifies for a session-ended activity entry.

The designated source has four explicit event consumers. `EventManager.Publish`
waits synchronously for each consumer and continues after individual failures;
it is not a detached logging callback. Session start publishes the logger before
queuing its session event. Session end queues its session event before publishing
the logger. Playback start/stop persist user playback state, await
`PublishAsync`, then queue the original playback event. Progress has no activity
logger. Accordingly the test reads the activity prefix immediately after each
HTTP response and never polls missing writes into that prefix. Activity WS
notifications must observe committed rows. Session-start and playback WS states
must observe their required committed prefixes; an ended-session frame is
allowed before its activity write, as in the actual source order.

Both hosts expose real admin `ActivityLogEntryStart` and `SessionsStart`
subscriptions. Keepalive acknowledgments fence their actual inbound protocol.
Forced business messages, complete raw frame data, event-time SQL readbacks and
real close handshakes remain available. Notification totals, private queue
sizes, diagnostic-log absence, CLR exception classes and stacks are not gates.
The protocol payload for an activity notification remains the actual empty
array; it is not replaced with an activity row.

The failure actions install actual SQLite/PostgreSQL `BEFORE INSERT` triggers
for only the scoped activity types. They cover failed session-start/end logging
and failed playback-start/stop logging. Authentication tokens must still work,
logout must remove the actual Device and session, both real users' playback
state must persist, and the original HTTP/WS consumers must continue working.
Normal playback after trigger removal demonstrates writer recovery. Trigger
definitions and diagnostics are retained; no controller, logger, service,
database or response is mocked.

Activity timestamps retain their original SQL value and full 100ns tick value.
Each new row is causally identified by the immediate before/after SQL prefix,
checked against its request's real clock range, then found by its actual ID
through the same host's ActivityLog HTTP reader using that exact instant.
The public entry's `Date` and stored `DateCreated` timestamp ticks must agree.
The reader request and original response are retained before assertions, so a
failed proof preserves the actual observation. Generated timestamps from independent
executions are compared by ownership and persisted relationships, while their
raw values remain available. UserData retains exact reported position ticks;
generated LastPlayedDate values are tied to their actual request or earlier
owner rather than rounded to milliseconds.

All actions finish before the completion marker is set. Native and Node action
and individual HTTP totals are reported separately; dispatch or a partially
recorded host is not completion. Cleanup attempts every WS, real host, SQLite,
production runtime, PostgreSQL and protected-input owner even after failure,
retaining the original error and cleanup errors. Only filtered reports and logs
are published after owners close. The original Native instance/build remain
protected. This bounded differential does not establish scanning, decoding,
transcoding, other activity producers, full-instance migration, production
scale or final release acceptance.

After the production runtime's real close resolves, a separately opened
one-connection PostgreSQL observer reads the stored activity rows and verifies
that the exact previously committed scoped rows remain. That observer closes
before schema removal; its actual close completion participates in ownership
cleanup. An early `closed` admission flag is not used as a drain/readback proof.
