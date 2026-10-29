# Complete original DVD through scan and exchange

`real-dvd-native.test.js` requires `dvdReference`, the designated Native build,
a fresh stopped Native instance and PostgreSQL. Actions `dvd_reference=true`
downloads the complete pinned NTSC Big Buck Bunny ISO and supplies its complete
VIDEO_TS. `native_reference=true` and `native_instance=true` are required too.
Strict full rejects missing, foreign, changed or incomplete input; an empty
directory with an otherwise complete receipt is an explicit refusal control.
There is no generated IFO, substituted transport, cropped title or local probe.

The first acquisition in Actions run `40494656261` verified all 8,294,793,216 ISO
bytes against the Archive SHA-1/MD5. It observed ISO SHA-256
`48dd35181c275d81788538c4d9e4846cd385e06edddd856fd6763e6d0ca22c96` and the
complete 60-entry VIDEO_TS containing 3,190,976,512 file bytes. That acquisition
establishes original input only; it does not establish this consumer's success.
The source descriptor now pins both the ISO SHA-256 and the complete per-file
VIDEO_TS inventory SHA-256. Every run reacquires the original and checks those
values. Metadata, all 3,248 original ISO members, complete payload inventory,
HTTP observations, actual libarchive executable and process logs remain in its
separate acquisition artifact.

Attribution: (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org.
The [producer's DVD data license](https://peach.blender.org/about/) is
[CC-BY-3.0](https://creativecommons.org/licenses/by/3.0/). Cover art, disc print
and trademarks are excluded. Complete original movie credits remain in place.

The consumer materializes every original VIDEO_TS member at one isolated Movie
path using ordinary hard links, avoiding a second multi-GB payload. The complete
tree is SHA-256 checked before and after actual consumers. The supplied original
tree stays intact and receives its own final input verification. Node's Local
plugin mounts media read-only; instance metadata has a separate writable mount.
No fixture metadata writer is allowed to mutate the original media namespace.
Validation file hashes stream bounded chunks rather than allocating whole VOBs.

Two fresh component processes run the current `ManagedFileSystem` and actual
`MediaEncoder.GetPrimaryPlaylistVobFiles`, then actual ffprobe on every default
selection. The entire original file set and SHA-256 values accompany each
capture. Explicit title 1 and absent title 99 exercise actual title selection.
This disc contains fourteen `VTS_*_1.VOB` files, each below 900 MiB. The designated
fallback groups the final underscore component, so its default includes all
fourteen files. The fixture observes that result; it does not assume a single
feature VOB or ten-minute duration. Node's actual VFS enumeration must select
the same paths and actual probe each selected VOB. Component comparison covers
the technical media values, declared persisted stream fields, chapters and
summed runtime. Full original MediaInfo and Node raw probe objects remain.

The designated source's `LocalMediaProxy` redirects individual VOB probes to
port 5244. The component owns an in-process Kestrel file/Range bridge while its
synchronous oracle process runs. The actual Native server uses a separate
streaming bridge backed by the real Local plugin and VFS. Both only expose the
complete declared originals. The server bridge records method, path, Range,
status, headers, read bytes/hash, completion or consumer cancellation and actual
read-handle closure. A source read or close failure remains a failure; an HTTP
consumer disconnect cannot replace it. The port lease covers all these phases.

The actual Native server first configures and scans an empty Movies library.
Its complete stopped instance, configuration and empty SQLite are retained.
After full DVD materialization, Native scans the real tree and supplies actual
Movie, stream, attachment, chapter and HTTP observations. Its complete instance
is then retained separately and the saved empty instance restored byte-for-byte
at the same physical paths. Node starts from the original empty PostgreSQL
import and performs its own actual first scan. Native-generated metadata and
cache never seed that candidate scan.

First-scan comparison covers the actual disc identity, type, name/SortName,
technical Movie values, persisted stream/attachment/chapter values and declared
technical HTTP Movie/source fields with complete public streams and chapters.
Independent creation/save clocks are retained without asserting identical
wall-clock samples. Generated relation row IDs are retained without an internal
allocation-order gate. Single frame-rate values compare their declared binary32
value; Int64s retain exact functional values. There is no recursive Guid, path,
date or unknown metadata rewriting. This scope is not complete Movie DTO parity.

Node edits Overview, Tags and an opaque provider key, saves user favorite state,
and shuts down normally. A fresh PostgreSQL owner and production Node runtime
read that state. Complete SQLite export is compared against all native business
tables, migration history, sequence state and insertion-sensitive relations.
The actual Native server takes over that export, consumes the edits and favorite
state, changes Overview through HTTP, and stops normally. A new PostgreSQL
import and cold production Node process must preserve the returned state.
Every transfer boundary compares the complete ordered database snapshot.

Raw successful HTTP bodies/headers, full disc rows and relations, Native source
bindings, complete component process receipts, raw probe values, transfer table
digests, input inventories and actual owner shutdowns are retained. The private
instance is published as credential-filtered reports rather than a public
credential-bearing SQLite image. No multi-GB media is uploaded. Native processes,
Node listeners/DB owners, the VFS bridge, file handles and both owned ports must
close before fixture publication and removal of its private working tree.

This fixture covers the original DVD input and its declared consumers. DVD menu
navigation, decoded playback, production catalogs, complete instance packaging
and release acceptance need their own evidence. This fixture never enables AV
generation or recording.
