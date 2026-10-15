# Collection/Playlist production resolver oracle

The actual pinned BoxSetResolver and PlaylistResolver execute over new real
files and directories. Neutral inputs cover markers, collection gates, five
playlist formats, exact collection.xml lookup, case-insensitive playlist.xml
suffixes, internal PlaylistsFolder without XML, provider attributes and trailing
separators. Equal-priority order uses the native assembly's exported-type order,
the same order ApplicationHost feeds to LibraryManager. Only these two resolver
types participate in the oracle's chain; complete resolver composition is not
claimed.

Resolved entities pass through the real ResolverHelper and ItemPersistenceService
with EF Core SQLite. All 72 BaseItems columns, full parsed and exact raw Data,
and provider relations are retained, followed by actual DeserializeBaseItem cold
hydration. Identity, parent lookup, fixed timestamps,
and virtual-path reversal are explicit controls. Playlist.ValidateChildren is
also called with a cancelled token and an unavailable path to freeze its no-op
boundary. Candidate production uses PostgreSQL only.

The candidate tests compare these outputs without deriving native expectations
from candidate code. VFS weak-snapshot and protocol/permission/cancellation
controls are separate safety tests, not native network recordings. External
playlist contents, complete scanner, metadata providers, watcher, HTTP, exchange
and release acceptance remain outside this fixture.

Separate candidate integration tests run the default production runtime and real
PostgreSQL. They exercise CreateItems/ValidateChildren, missing XML under a mapped
PlaylistsFolder type control, retained links, BoxSet child recursion and the
structural scanner's Playlist no-traversal rule. Metadata modes in that structural
scan are None; these are not full native scan or metadata-provider recordings.

Record using the isolated clean pin and .NET via
`tools/compat/record-collection-playlist.mjs NEW_OUTPUT_DIRECTORY`. Prior native
fixtures and failed/new recordings remain intact. The seal covers actual loaded
runtime, source/input/oracle bytes and dependency-resolution files, not a complete
native build-input closure.
