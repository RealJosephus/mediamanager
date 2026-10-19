# Movie/Trailer Similar oracle

The oracle runs the actual pinned `MovieSimilarItemsProvider`, concrete
`BaseItemRepository`, and EF Core SQLite in a new isolated output directory.
The neutral input is shared with candidate PostgreSQL tests. No candidate code
generates expected results. `ConfigureUserAccess` is a controlled seam selecting
one top parent; this is not complete user-policy or HTTP acceptance evidence.

Cases cover weights, duplicate relation rows, exact cleaned-value/person-type
matching, source-key insertion and stable access tie order, presentation-key
grouping, primary/alternate versions, owned extras, external content, played
state shared between siblings, exclusions, and the pre-access three-times-limit
shortlist without refill. The pin's parent-constrained access lookup uses its
Type/TopParentId/Id index; an unconstrained lookup uses its Id key. Candidate
ordering preserves these recorded implicit tie orders, which require additional
production-scale validation. A userless provider with candidates throws because
native IsPlayed filtering requires a user; the manager catches that exception.
Production does not use SQLite.

The real Live TV provider records movie-first, series and other-program query
branches, including four-item metadata-key overfetch. The other-program branch
requests `Program`, which the pin's ItemTypeLookup does not map and therefore
matches nothing. TMDb Movie uses a real TMDbLib client over a controlled handler
to record Int32 ID gating, two pages, empty-page stop, transport failure and
cache duration. These probes do not claim deterministic Random ordering or
public-network acceptance.

Record with the isolated pinned baseline DLL directory and bundled .NET, then
seal with `tools/compat/record-movie-similar.mjs NEW_OUTPUT_DIRECTORY`. It records
the raw result, input, oracle sources, runtime assemblies, dependency
resolution files, and relevant pinned source files. Do not rewrite existing
Shows golden results to claim these branches are covered.
