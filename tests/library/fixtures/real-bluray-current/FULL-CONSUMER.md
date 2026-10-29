# Complete original Sintel library and database consumer

`real-bluray-native.test.js` requires the explicit `blurayReference` service,
the designated current Native build and stopped instance, and PostgreSQL.
The same-job source contract is documented in `README.md` and
`tools/ci/bluray-reference/CONSUMER-SUPPLY.md`. The complete frozen official ISO
and every original UDF/BDMV member remain mandatory before and after the test.
Ordinary hard links materialize all 14 complete BDMV files, both M2TS streams,
all backups and every empty original directory at one isolated `Sintel (2010)`
Movie path. Complete before/after file hashes cover this scanner input and the
separately retained source supply. No encoder, muxer or recording creates input.

The test reuses the existing DVD fixture's streaming Local/VFS media owner,
mapping the current inventory's `kind` to that owner's `type` parameter. It
does not duplicate its streaming, Range, cancellation or close implementation.
The bridge exposes only the declared complete originals. It records actual
Native reads, their phase, request, Range, status, headers, byte count/hash,
completion or consumer cancellation, and actual file-handle closure. The shared
5244 lease covers the component processes and the Native server consumers.

The same real Native BDInfo/MediaEncoder Oracle runs twice in new processes.
Its full disc observations, complete source file hashes, actual assembly
bindings, selected playlist/clips, chapters, streams and original ffprobe
results remain available. The actual server's `FFProbeVideoInfo` obtains
BDInfo first and probes its first M2TS; `FetchBdInfo` then merges the playlist
runtime, chapters and streams. The new consumer binds those actual source
files and uses this server boundary when checking the first scan, rather than
requiring every clip probe performed by the separate component to be repeated
by the server. Node's real production Blu-ray planner and every observed Node
probe must consume the same actually selected originals. Probe results compare
against the actual MediaEncoder values. No `bd_info` CLI substitutes for Native.

Native first creates an empty Movies library, scans it, and stops normally.
Its complete empty instance, configuration and SQLite remain available. The
empty SQLite is imported into a fresh PostgreSQL schema. Native then scans the
complete disc and supplies the actual Movie identity, BluRay type, persisted
technical rows and complete public stream/chapter observations. Its resulting
instance is retained separately. The saved empty instance is restored at the
same paths, with its unchanged configuration and database checked, so the
independent first production Node/PostgreSQL scan receives no metadata or cache
created by the Native disc scan. The media mount is read-only; instance
metadata uses a separate writable mount.

Independent first-scan comparison covers identity, type, Name/SortName, declared
technical Movie values, stream/attachment/chapter values, and declared public
Movie/media-source fields with complete public streams and chapters. The raw
rows and successful HTTP bodies/headers remain available. Independent creation
and save clocks and generated relation row identifiers do not acquire a false
equality requirement. Declared Single frame rates compare their binary32
functional value. There is no recursive date, Guid, path or unknown metadata
rewriting, and no complete Movie DTO parity claim.

Node edits Overview, Tags and an opaque provider value through HTTP, saves user
favorite state, and shuts down normally. A new PostgreSQL owner and cold
production Node instance must preserve them. Exported SQLite compares the whole
ordered snapshot: all 31 business tables, original migration history, sequence
state and all six insertion-sensitive relation streams. The actual Native
server takes over that SQLite, consumes the edits and favorite state, changes
Overview through HTTP and stops normally. A fresh PostgreSQL import and cold
Node process read the Native continuation. Every transfer boundary compares
the full snapshot without dropping unknown Data or any raw TEXT value. The
original Node PostgreSQL schema must also remain unchanged by this continuation.
Each post-edit, cold, Native-imported, Native-continued and returned cold HTTP
read also checks the exact expected Overview, both ordered Tags and the opaque
provider value; only the declared Native Overview edit changes that expectation.

Original input bindings, Native source/assembly/process observations, raw probe
results, full ordered snapshot digests, HTTP responses and actual shutdowns
remain in the report. Cleanup preserves the primary failure and every later
cleanup failure in order. Actual owner close results, both ports, Local/VFS
handles, SQLite and all admitted PostgreSQL pools must complete successfully.
An owner close failure retains the private tree and publishes a small filtered
report; forced termination is not a successful natural shutdown. Only reports
are published after normal closure, with credentials filtered and no multi-GB
media or credential-bearing SQLite image uploaded.

This is one complete open-movie disc and its declared real consumers. It does
not establish commercial or encrypted discs, BD-J/HDMV menu decoding, decoded
playback, every Blu-ray profile, production-scale libraries, complete instance
packaging, phase acceptance or final release acceptance. Its implementation
awaits actual three-platform CI results; source acquisition and component
results retain their own narrower scopes.
