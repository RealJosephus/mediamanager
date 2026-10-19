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

The current observation uses the independently closed designated source build
whose main DLL starts with SHA-256 `474c7c`. Its full source, runtime and SDK
trees were checked before and after the fresh native helper execution. The
provenance binds the actual record and raw output, loaded assemblies, native
SQLite, dependency resolution files, helper inputs, relevant source files and
full build receipt. No old Git working directory is required by this profile.

The previous fixture and its source declarations remain byte-exact in the
external historical snapshot. All sixteen historical Git source blobs match
their recorded hashes, but the missing old native run and runtime have not
been recovered. The new observation has its own identity and is not a seal of
that old execution. Its fourteen movie results, four Live TV branches and
controlled TMDb observations equal the retained projection. No existing Shows
golden result is rewritten to claim coverage for these branches.
