# Live stream Session lifecycle

The oracle instantiates the designated DLL's real `SessionManager`. It calls
`LogSessionActivity`, playback Start/Progress/Stopped, bidirectional stream
mapping cleanup, `CloseIfNeededAsync` and `ReportSessionEnded`. It also invokes
the actual private idle and paused-inactivity callbacks. A synchronization
context waits for the real async-void operation's `OperationCompleted`, with a
deadline; it does not use a quiet-period sleep or copy a C# loop as an oracle.

Users are explicitly absent and most reports supply a controlled `BaseItemDto`.
One additional lane lets the actual manager generate its item info through a
declared DTO service and media-source callback. A controlled source revision
then changes the available tracks. Actual Progress/Stop must reuse the current
DTO without repeating either callback, preserving the earlier live tracks.
Node observes its real registry getter and changes only that callback's cloned
track projection; it does not mutate the registry or substitute session results.
The media-source manager's Close callback records the requested identity, can
throw once, or can hold a real Task until the fixture releases it. Device,
library, event delivery and host lifetime interfaces are declared controls.
The event manager records the actual event objects published by SessionManager.
No native EF database, physical tuner, byte stream, probe, encoder or recorder
is opened. Error status comes from actual `ExceptionMiddleware.GetStatusCode`.

Actual `SessionInfo.StartAutomaticProgress` and SessionManager check timers are
created by playback. Reports are paused so the real automatic progress callback
cannot advance positions during the fixture. After each step the oracle records
whether its actual progress timer existed, calls the real
`StopAutomaticProgress`, and checks release. Final `SessionManager.DisposeAsync`
must release every real progress/idle/inactive timer and owned controlled
controller. These timers are never replaced with fake instances. Last-check-in
and paused dates are explicit inputs to the actual timer callbacks; native wall
clock values themselves are outside the selected comparison.

Node executes its actual `SessionService` with real PostgreSQL DeviceOptions
reads and the actual public `LiveStreamsService`. Tuner acquisition, supplied
media identity/DTO and probe are declared controls. Every public open returns
a tracked lease, which is released by the real registry; readers are forbidden.
The controlled tuner declares one stable shared-input capability for these
opens, with independently owned retain/close leases. The two-session case
therefore measures two consumers of the same actual registry entry. Fresh
inputs with equal source IDs and replacement/retirement are a separate public
registry scope; this fixture does not turn those into shared owners.
Each step compares exact close-call identity/order, selected session state,
published report/end/command sequence and errors against the actual oracle.
Registry ConsumerCount and lease counts are additionally checked independently;
the controlled native Close callback is not represented as native registry
counter evidence. All real Node session timers and registry/store owners close
before PostgreSQL is dropped. UserData and DeviceOptions remain unchanged.

Eleven scenarios cover insensitive outer live identity, exact inner session/play
keys, replacement removal, absent play IDs, unknown Progress, normal and negative
Stop, an awaited close before the argument error, logged close failure, explicit
session end, last-controller disconnect, idle stop, paused inactivity and current
DTO/live-track reuse. Callback counts, exact selected DTO/track fields and the
original raw mapping snapshots remain evidence of their declared boundaries.
The idle callback stops playback without passing LiveStreamId, preserving the
mapping until an explicit close. Paused inactivity sends a remote Stop command
and retains playback/mapping. Explicit ReportSessionEnded disposes its session
without closing a live stream; a disconnected final controller closes before
SessionEnded. These paths are compared separately.

Inputs, source bindings, actual executing assembly hashes, native raw mapping
snapshots, timer evidence and Node resource observations are published under the
authorized validation directory. All validation runs only in Actions. This
does not establish authenticated user-data semantics, HTTP session delivery,
native MediaSourceManager registry behavior, recording or final release acceptance.
