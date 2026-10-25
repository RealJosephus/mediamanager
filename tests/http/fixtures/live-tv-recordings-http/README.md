# Existing recording HTTP differential

`live-tv-recordings-native.test.js` starts the designated current native build
from a private clone. Before native startup, a harmless text marker is placed in
each existing recording directory. Native `DirectoryService.IsAccessible`
requires at least one enumerated entry for a top-level library root; an empty
directory is deliberately skipped. Marker bytes and SHA-256 join the later
read/delete/shutdown snapshots and must remain unchanged.

Real native startup registers the two recording directories. The fixture waits
for their actual library definitions and scheduled workers, disables the private
libraries' realtime monitors and scheduled triggers through native APIs, then
explicitly starts the registered `RefreshLibrary` task through
`POST /ScheduledTasks/Running/{id}`. It requires a new `Completed` execution and
both actual recording-folder DTOs before stopping the process. This avoids
assuming a startup queue request made before task registration performed a scan.
The stopped seed then adds persistent Movie/Episode/Video data beneath those
actual collection/physical folders. The controlled files are ordinary existing
media; no timers or recording jobs are created. Before the first native startup,
the original controlled seed's bound identities and source paths are checked,
then relocated inside the private mapped media root with a real retained file.
The before/after rows and file SHA are recorded. Doing this before startup lets
the real native registration scan see existing files; it must not remove a
nonexistent synthetic path before the fixture attempts to relocate it. Root
validation may still legitimately remove an unregistered synthetic child; the
stopped seed step records actual surviving rows and identities without restoring
them and verifies the retained file's original SHA. The controlled recording
rows are seeded only after this real native registration and scan phase completes.
No collection or physical recording-root row is fabricated by the fixture, and
missing roots remain a failing assertion.

Actual native APIs create users, policies, sessions, an API key and favorite user
data. The native reader is restarted to exclude stale entity caches. Complete
raw HTTP responses cover LiveTvAccess, management permission, user selection,
binding, defaults, ignored filters, type/genre selection, repository paging/count,
incomplete external livestreams, obsolete Series/Groups, folders and arbitrary
typed detail items. Dates compare exact ticks and UTC kind; raw responses remain
in the evidence.

After read-only before/after/shutdown snapshots, the actual stopped SQLite graph,
accounts and related rows transfer to a new PostgreSQL schema with a portable
mapped-local mount contract. `startProductionInstance` serves the candidate HTTP
routes; this uses the real transfer implementation and production runtime, not a
CLI invocation. The same credentials and persisted identities are retained.
The candidate keeps actual external `Channel` rows in that graph. Startup and
the entire read/delete/shutdown phase must report no hidden runtime diagnostic;
both Error objects and string warnings retain their value and observation stack
in the report so a warning cannot collapse to an empty JSON object. A diagnostic
is labelled `expectedRequestDiagnostic` only after an exact method/route/sample/
identity-mode match, identical actual native and Node error status and complete
wire response, and the precise Node error message/status and originating stack
all pass. Known request failures are other-user selectors (403), the three
physical-folder requests with no selected user (400), this retained Channel's
empty source `ChannelId` in standalone access or the selected media-source-display
getter (400), and this exact empty DELETE identity (400). All other diagnostics,
including any Node 500, remain failures. The native read/delete logger blocks
for these argument failures are retained separately after actual process stop.

The registered physical Folder reaches native `BaseItem.IsVisible(null)`, which
throws `ArgumentNullException`; native `ExceptionMiddleware` maps it to HTTP 400.
An empty physical-source sequence instead reaches the manager's `user.Id`
dereference and yields 500. This HTTP fixture retains real physical roots and
therefore cannot authorize that latter status. Actual nullable-source variants
and their typed virtual-method short circuits are measured by the separate
recordings component fixture. For a selected `EnableMediaSourceDisplay`, native
first resolves `ChannelId` and rejects empty IDs even with an empty channel
provider inventory. An unselected field must not evaluate that getter. Nonempty
missing/wrong-type IDs retain the empty-inventory short circuit; nonempty channel
provider inventory and `IDisableMediaSourceDisplay` consumption remain an
unimplemented producer boundary rather than a supplied compatibility result.

The retained external livestream and complete external programme are ordinary
file-backed Videos with nonempty ChannelId. While the private native instance
is stopped, the fixture installs two exact `channelmediasourceinfos.json` files
in the native BaseItem metadata paths. One contains ordered opaque/self HTTP
sources and distinct audio tracks; the other contains the original retained
file and video/audio streams. Actual authenticated and userless HTTP DTOs must
successfully consume these sources, preserve their IDs/order/paths, and expose
the first cached stream list and associated ChannelName. The detail action does
not bind the requested fields and must omit MediaSourceCount. Separate actual
list requests select that field: native DtoService deliberately omits a
single-version count even when a cache contains two sources, and a userless
API-key recording list is empty. Both exact wire behaviors remain asserted.
Their complete wire responses are then compared against the migrated production
PG runtime. Every cache byte joins the state snapshots before/after reads,
deletion and shutdown. No saved URL or retained media is opened or probed by
these static consumers. The separate
`tests/library/channel-static-media-sources-native.test.js` additionally covers
empty-cache fallback, normalization/errors, user filtering, playback ordering
and held-reader shutdown. External Channel provider execution remains outside
both fixtures.

Native and Node DELETE runs start from the same pre-delete graph and compare
authorization/binding/status, complete changed rows, remaining source bytes and
timers/configuration bytes. A user with LiveTvManagement and disabled ordinary
content deletion deletes only the record and relations; every controlled media
file must remain. Every process, HTTP listener and PG schema is cleaned up and
the protected input/build manifests are checked by `currentNativeReference`.

This is targeted HTTP evidence. It does not demonstrate recording, tuner/listing
execution, external channel providers, image delivery or final release acceptance.

The separate `tests/http/live-tv-recordings.test.js` integration places its
ordinary Audio cleanup marker in the real external manager's loaded attachment
directory. Its management DELETE must remove that managed directory and the
internal metadata while preserving the source file, database/event prefix and
authorization behavior. It does not replace the manager's path discovery or
use the controlled external-provider marker from the general leaf oracle.
