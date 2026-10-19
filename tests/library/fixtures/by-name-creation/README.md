# Genre and Studio creation

`Program.cs` runs the designated Jellyfin `LibraryManager.GetGenre` and
`GetStudio`, its actual item cache, `ItemPersistenceService`, EF SQLite and
directory creation in isolated instances. Each type has 15 independent cases:
creation, reuse, repeated lookup, replacement of another by-name type or a
Movie, wrong-type warm-cache repetition, Unicode and sanitized names, empty and
long names, ID configuration, an existing file, and a controlled save failure.

Every pre-action and resulting BaseItems row contains all 72 mapped columns.
The recording preserves return values, provider rows, directory existence and
timestamps, save calls and Added events. Application paths, virtual path
projection, collection membership and the save-failure injection are explicit
controls. No media or listening port is opened. Oracle source and assembly
hashes, designated-source bindings and process results are in `provenance.json`.
The native bytes are unmodified; complete designated-build closure and final
release acceptance remain unproven.

`../../by-name-creation.test.js` seeds the independent constructor rows into
PostgreSQL and compares every resulting column, return value, provider, event
and failure prefix. It binds each system's directory times before replacing
them with clock markers for comparison. It also checks real PostgreSQL save
failure and retry, repeated reuse, and metadata junction refusal for both types.
The runtime HTTP Studio and Genre-menu fixtures cover their consumer flows.

The behavior comes from GPL-licensed Jellyfin sources; their exact paths and
hashes are retained in provenance. This is a development oracle, not a production
.NET dependency.
