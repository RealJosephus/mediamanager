# Current Book consumer observations

This fixture records five independent components against the same-run supplied
Jellyfin reference. Each selected component executes twice in separate processes
and state directories. `capture.js` binds the declared scenario bytes, oracle
sources, designated upstream source offer, loaded assemblies and SQLite native
library where used. Original recordings and provenance under `book-dto`,
`book-lifecycle`, `book-provider-order`, and the library `book-directory-source`
fixture remain unchanged. Their unavailable historical builds are not replaced
under the historical identities.

| Component | Actual Native observation | Candidate consumer |
| --- | --- | --- |
| `dto` | `DtoService.SetBookProperties` and the supplied JSON serializer for the original null, empty and curated `SeriesName` values | Projection, PostgreSQL item service, authenticated HTTP query, complete returned DTOs and unchanged stored rows |
| `lifecycle` | All 17 lookups, 64 merges and 11 refresh scenarios through the actual Book metadata service and ProviderManager with controlled provider and save callbacks | Lookup and merge, physical-parent PostgreSQL lookups, refresh, cancellation, provider and repository failures, committed save prefixes and timestamps |
| `owned` | All 16 original file and directory owner boundaries through real extra discovery, files and SQLite persistence | Owner-path extra source/type selection, PostgreSQL Book owner discovery and non-video Book refresh isolation |
| `order` | Built-in CoreAppHost export discovery and ProviderManager default, global and library local-reader ordering | The application's actual registered Book readers and independent local-metadata/image configuration capabilities |
| `directory` | All three original extension-named directory and ordinary-file controls through BookResolver, ResolverHelper and the real filesystem | Directory item sources, names, types and consumed paths, plus all six invalid-source admission boundaries |

The lifecycle and owner components keep controlled dependency callbacks explicit.
The owner capture uses actual SQLite and resolvers but performs no Photo/JPEG tag
decoding. The provider-order capture performs discovery without running readers
or starting a Native server. The directory capture does not run a recursive scan
or persistence. These observations do not establish hosted Native HTTP,
full-instance, phase or release acceptance.

Each capture preserves full raw output and build records. Candidate observations
are written beside the captures, including full service and HTTP DTOs. Functional
comparisons use the values and failure/commit boundaries consumed by each test;
raw exception names and discovery implementation names remain diagnostic data.
PostgreSQL schemas and temporary candidate runtime directories are released by
the tests. Native state stays inside the isolated validation evidence root.
