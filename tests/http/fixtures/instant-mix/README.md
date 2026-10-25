# InstantMix HTTP and repository recording

`Program.cs` hosts the designated `InstantMixController` in actual ASP.NET MVC
with its model binders, authorization filter and production exception middleware.
The native `MusicManager`, `Folder` traversal, generic `LibraryManager` lookup,
resident entity cache and MusicGenre name identity execute directly from the
isolated assemblies. `input.json` supplies 74 HTTP requests and entity definitions.
Authentication principals, user lookup, repository membership, individual genre
lookup failures and DTO projection are explicit controls. The HTTP capture does
not open a database or media source.

The recording covers all eight controller routes, generic aliases versus typed
Playlist lookup, missing/empty/invalid IDs, nullable scalar and repeated/comma
enum binding (including undefined numeric image types), cross-user authorization, an API key without a selected user,
negative/zero/positive limits and totals, first-song retention, empty/nonmatching
genre selectors, curated genre names, recursive links/cycles, a books-view cast
failure after a successful lookup prefix, and warm Album/Artist/Playlist sources
after repository replacement or persistence-only deletion.

A separate probe executes the actual `MusicManager`, `LibraryManager` and
`BaseItemRepository` over EF SQLite. Its ten cases distinguish persisted
`CleanName` from displayed `Name`, null/empty/case-sensitive clean names,
unconstrained selector types, duplicate clean selectors, missing IDs, Guid.Empty
and an empty selector. Genre membership comes from actual ItemValues relations,
including an audio item whose display column has a genre but no relation, and
an AudioBook excluded from the exact Audio repository query.

The native Random implementation is exercised by the SQLite probe. Comparisons
verify full membership where no random truncation occurs and retain a song
source's first position. They do not require matching random order. HTTP DTO
comparison covers the controlled projection and captured options; the candidate
also runs actual PostgreSQL hydration, persistence and Added notifications.
The fixture is not a full native DTO/authentication/HTTP/filesystem/SQLite run,
two-client acceptance, or a complete build-input-closure claim.

`native.json` is the original output, copied without newline normalization.
`provenance.json` binds input, C#/project/shared build properties, executable,
SDK, designated source files, runtime SQLite artifact and evidence location.
The listed designated files were checked byte-for-byte against their isolated
build copy. Re-record into a new directory with `tools/validation/oracle.js`,
using the isolated designated DLL directory and SDK; never change the source
workspace or overwrite previous attempts. Managed runtime assembly hashes are
included in the native output. Fixture byte identity is checked independently
of functional JSON comparisons in `tests/http/instant-mix.test.js`.
