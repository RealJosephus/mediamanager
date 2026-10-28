# Actual item Download HTTP consumer

`tests/http/download-native.test.js` starts the designated same-run Native
server in an owned clone. Actual HTTP APIs create two empty libraries, three
users with distinct download policies and a userless API key. The server stops
before a bounded set of typed items is inserted into its real migrated SQLite
schema. No controller, authorization service, user manager, item repository or
activity manager is mocked. These rows are controls for the Download action;
they do not claim that a scanner resolved arbitrary media bytes.

One complete stopped database is frozen before the actual Native Download
matrix runs. The production Node entry point imports that same frozen input
into real PostgreSQL, with explicit local and HTTP storage mappings, then runs
the same requests and reads its actual committed activity rows. Native and Node
use identical item and user identities, user policies, token/device inputs,
filenames, source bytes and declared HTTP capabilities.

The complete Native input retains HTTP(S) scalar paths for Photo, Book, Audio
and Movie items. Exchange preserves the original credential-free URI spelling
and query bytes for those exact persisted Native types. Their download gates
and user policies still apply: the remote Book, Audio and Movie controls retain
their actual `CanDownload=false` DTOs and Download refusals. Source bindings
include `BaseItem.PathProtocol`, `MediaSourceManager` and `BaseItemMapper` for
the native protocol, persistence and typed-controller boundary. Unknown root
`Data.Path` members retain their opaque original JSON.

The matrix covers 38 Download requests and `CanDownload` DTOs for four identities
and twenty visible typed items. It includes anonymous and invalid credentials,
allowed/blocked users, an administrator whose download permission is false,
API keys, GUID binding, an empty or missing item, tag-hidden content, ordinary
Book/Photo/Audio/AudioBook/Video/Movie items, folders, DVD/BluRay, original STRM
files, remote items, Photo and Book without a path, Unicode/quoted attachment
names, partial/suffix/unsatisfied ranges, matching and stale If-Range, GET-only
HEAD selection, source failure after the activity commit and a real activity
write failure. Failed activity writes are injected by temporary native SQLite
and PostgreSQL triggers; the underlying controller still opens the real source.
The Native trigger uses one SQLite handle that passes the complete schema
preflight before injection and stays owned through trigger removal. All triggers
are removed before the owner closes.

A Photo without a path passes the typed download gate and commits its user
activity before returning HTTP 400. The actual controller evaluates the MIME
lookup before constructing its file result; a missing or empty filename is an
invalid request at that boundary. The fixture retains that response and its
persistent activity prefix without comparing framework exception internals.

The local source controller in the designated workspace uses port 5244.
This fixture owns that port and serves only declared physical files; it has no
deleted-file or directory fallback. Remote Photo requests use the same actual
HTTP source on both runtimes. Only those remote cases use If-Range: their source
has an explicit strong ETag and honors matching validators. Local inputs retain
their real filesystem semantics. The small arbitrary binary payloads and STRM
pointer bytes are download inputs; no media decoder, probe or encoder runs.

Every response retains status, headers and complete bytes. Every request keeps
the before/after committed download activity rows. HTTP entity framing may use
Content-Length or a completely consumed chunked body. A declared unencoded GET
length must match that response's actual full bytes; its presence is not compared
between runtimes. Status, attachment and MIME headers, range semantics and full
body bytes remain functional checks. HEAD and encoded-body lengths retain their
separate HTTP meanings and original headers. The Native upstream handler
observes SQLite before sending source bytes. The candidate resolves the declared
local mount through the configured VFS facade. The plugin adapter facade retains
the actual installed owner's prototype, whose `openRead` the plugin scope calls
dynamically. The fixture observes this real method entry before delegating with
the original receiver and arguments.
It reads committed PostgreSQL rows without supplying replacement source bytes.
Only the actual source root and active case's declared path, resolved through the VFS,
participates in the download-prefix observation; instance and metadata reads
use their unchanged storage operations.
Remote reads retain the real HTTP source observer. The original prototype
descriptor is restored before runtime shutdown; restoration failure cannot skip shutdown.
The activity prefix must already exist at that boundary, including a source 404;
API keys add no activity.
The activity's user/item/name/client/device/severity/row version values compare
exactly. Fresh IDs must be valid and new, and actual timestamps must belong to
the request window. JSON layout and opaque request trace IDs are compared under
the existing protocol contract; CLR error classes, stack traces and diagnostic
log counts do not control acceptance.

Only filtered reports, Native logs, source/build identities and cleanup evidence
are published. Original private databases and credentials are removed after
the production runtime, Native process and source server have actually closed.
File resource leases cover port 5244 and actual discovery through that cleanup.

Run only in GitHub Actions with `native_reference=true`, `native_instance=true`
and isolated PostgreSQL. The test uses the actual HTTP host and controllers but
does not claim media decoding, scanning, production scale, complete-instance
migration, WebSocket delivery or final release acceptance.
