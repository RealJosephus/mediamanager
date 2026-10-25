# Channel Items and Latest component differential

The oracle calls the supplied assemblies' actual `ChannelsController` actions,
`ChannelManager`, `LibraryManager`, `BaseItemRepository`, typed mapper,
`ItemPersistenceService` and `DtoService`. Each scenario owns a fresh SQLite
database created by the actual EF model. The current SDK RID's packaged SQLite
image is loaded by absolute path with an explicit provider resolver; its path,
RID and SHA-256, managed assembly SHA-256s, source bindings and exact input hash
are retained. This is a component fixture, not a production SQLite migration or
a complete native HTTP host. Native controller parameters are supplied directly;
MVC comma binding, authorization middleware and wire serialization are not
claimed by those action observations.

The Node side seeds the actual native `beforeRows`, including EF's placeholder,
into a new PostgreSQL schema. Those rows are read directly from the owned SQLite
connection after actual EF persistence, rather than re-serialized EF entities:
native DateTime TEXT separators and fractions retain their real stored bytes.
It installs a controlled package through the real
PluginHost/SDK and uses the actual Channel service, mapped storage, SQL snapshot
queries, item creation/repository updates, stale deletion, saved media sources
and DTOs. Selected cases also use the real Node HTTP application. HTTP diagnostics
are recorded with their exact request and compared to the native action's
exception type, status and, for argument errors, message. No 200 difference is
classified as a request diagnostic. Provider source envelopes are unwrapped
only at the shared typed ChannelItemResult boundary; explicit nulls remain input.

Action comparisons retain the complete actual `BaseItemDto` JSON from both
implementations, including fixed/default properties outside the requested
optional `Fields`. Missing properties and explicit nulls are not made equal.
Only each scenario's owned directory prefix is normalized; both controlled
application hosts use the same fixed server identity.

Provider responses, read-only user data, `RefreshSingleItem` and `QueueRefresh`
execution are controlled. The latter two record their actual consumption
boundary; they do not execute metadata providers. Repository writes, cache files,
SQL selection and DTO projection are real. No stream, media probe, image
generation, recording or encoder runs. `ISupportsMediaProbe` is exercised as the
native materializer marker without invoking a probe. The Latest marker callback
throws if executed: actual Latest must use ordinary root items and one Folder
level instead. Root snapshots remain fixed while each folder is refreshed.

Sequential cases cover the native runtime classes, full Int64 runtime, saved
source defaults, cache key input and three-hour invalidation, cache hit sentinel,
null versus malformed cache JSON, late null-collection failure, committed item
prefix, and filtered/paged dead selection. A null MediaSources list remains
null through provider binding and reaches the actual nullable IReadOnlyList
FirstOrDefault overload, which permits creation with no source Path. Manual
cache preparation calls each implementation's real provider cache-key callback,
so that setup observation is retained in the callback sequence.
Existing media Path/runtime edits
that do not force a repository update are observed twice: the warm cached item
and the independently cold repository DTO. Neither lane substitutes its state
for the other. Cache and source JSON are compared as typed values, retaining
100 ns date fractions and explicit invalid JSON bytes. Native persistence call
records are retained as evidence; the assertion compares the resulting persisted
state and queue/provider order rather than imposing the same number of internal
SQL statements on two different repositories.

The held provider case is Node lifecycle evidence. Channel and Library close
begin while the installed provider is awaiting a fixture gate, then metadata
lifetime cancellation begins. The synchronously admitted Library frame must
finish materialization, SQL filtering/DTOs and cleanup before both owners close.
New Channel operations reject; the old operation does not reopen a closing
Library owner. Every context, temporary selection and linked state is released.
Fixture cleanup validates absolute owned-directory containment before recursion.

Only `componentAcceptance` may become true after every hard assertion and
comparison passes. Phase and release acceptance remain false. Full native MVC
HTTP, scheduled Channel refresh and broader provider item shapes require their
own evidence; this fixture does not claim execution merely from marker presence.
