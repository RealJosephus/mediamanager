The remote test uses the designated current Jellyfin assemblies and a private
copy of the same-run stopped database. It executes real MVC/default policy,
LyricsController, LyricManager, MediaSourceManager, MediaStreamRepository/EF,
LrcLyricParser and TxtLyricParser. Authentication principals and Native library
lookup/visibility and virtual-path application roots are controlled. Node uses the complete runtime with real
users/tokens/permissions, PostgreSQL and the installed Local/HTTP storage plugins.

The private lyric source serves the designated LocalMediaProxy path at port
5244 under the existing job-local lease. Local cases explicitly use a response
without charset, matching Local storage handles without Content-Type. Separate
HTTP cases exercise declared charset and BOM overrides. The report retains the
source bytes/identities, headers, actual delivered bodies and source bindings.
It does not claim arbitrary proxy headers are equivalent to Local storage.

Synthetic, original text covers timed/unsynced lyrics, ELRC cues and UTF-16
positions, stream ordering and fallback, culture, invalid text, BOM/charset,
permissions and errors. No music lyrics or media analysis/generation are used.
Cold runtime consumption verifies persistent stream and storage bindings.
Injected Node-only failures operate over real Local/VFS/PG owners; the actual
PostgreSQL backend is checked after an SQL read/close failure and the same HTTP
consumer reads again. They are not presented as paired Native failure injection.

The source-pinned parser dependency is LrcParser 2025.623.0, whose NuGet repository
commit is [ae8e5a182e7841a8150e852bb8cd6a9e01be3548](https://github.com/karaoke-dev/LrcParser/tree/ae8e5a182e7841a8150e852bb8cd6a9e01be3548).
The Node port retains its MIT notice in src/lyrics/LrcParser.LICENSE. The oracle
uses the actual installed dependency rather than a substitute parser.

This stage implements only GET /Audio/{itemId}/Lyrics. Upload/delete and their
metadata-refresh semantics, remote provider search/read/download, and provider
installation are not implemented or accepted by this fixture. Native's provider
list is empty and unused by GET. This is no complete release acceptance claim.
