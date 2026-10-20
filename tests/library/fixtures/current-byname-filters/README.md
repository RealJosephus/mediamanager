# Current native by-name filter inputs

The four `*-input.json` files and `studio-expected.json` are byte-for-byte copies
of the corresponding historical `fixtures/{artist,studio,genre,album}-filters`
inputs and Studio control expectations. `input-identities.json` preserves their
original SHA-256 identities. Historical recordings and provenance are unchanged.

The current consumer executes the four original main scenarios against an
isolated clone of the workflow's freshly initialized native instance and its
bound Jellyfin build. The fixed input user is explicitly bound to that instance's
authenticated user; synthetic media identifiers and scenario values are retained.
It records all native HTTP bodies, pre-request SQL, subsequent SQL and filesystem
states, process shutdown, executable identities, and source bindings. Expected
control values are assertions only, never substituted for observations.

The native instance, SQLite database, configuration, and unredacted working
reports stay in a private temporary directory. Publication copies only top-level
JSON/log reports, replaces credential fields and known credentials with SHA-256
markers, rebinds report digests, and removes the private directory in `finally`.
Media rows, relationships, HTTP result fields, and functional assertions remain
unchanged. Candidate reports apply the same credential redaction.

The candidate uses the pre-request native rows as controlled input and the same
requests against PostgreSQL and the actual runtime. It compares complete HTTP
responses, all columns of new by-name/UserView records, unchanged existing rows
and relationships, filesystem changes, and cleanup. Per-instance user/view IDs
and newly generated creation timestamps are projected explicitly. Raw outputs
are retained before comparison.

Scope: Artist main 49 cases / 95 responses, Studio 34 / 68, Genre 34 / 68, Album
59 / 112. Four separate Artist probes add eight responses: unknown name, BOM
name, repeated name followed by whitespace, and BOM followed by whitespace.
Their controlled requests and reduced initial graphs are defined in
`tools/compat/artist-filter-input.js`, independently of native output. Each probe
compares every created column, existing rows and relationships, directory
creation, and the repeat endpoint's preservation of the first materialization.
Execution requires the workflow's `nativeInstance`, native build, tools, and
PostgreSQL services and occurs only in GitHub Actions.
