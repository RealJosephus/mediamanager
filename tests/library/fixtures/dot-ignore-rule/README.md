# Native .ignore rules and cache recording

The oracle calls the actual frozen `DotIgnoreIgnoreRule.CheckIgnoreRules`,
`ShouldIgnore` and `ClearDirectoryCache` from the modified Jellyfin workspace.
It also extracts the bound .NET runtime's complete BMP case equivalences,
Unicode categories and Unicode block definitions. Production uses those facts
with UTF-16 matching rather than JavaScript Unicode case folding.

There are 67 rule groups (263 checks), 24 real file operation groups, and five
actual `BitFaster.Caching` 2.6.1 sequential cache groups (2298 operations).
Every cache operation records its result, all live key/value entries and all
three queue counts. These samples include warm-up, eviction, access, updates,
removed nodes, reinsertion and clear. The cache capacities are controls.

File cases use nearest ancestor selection without merging, full identity paths,
directory searches, cached absence, intermediate cache hits, deleted files,
timestamp/length changes, same timestamp and length, clear and UTF-8/16/32 BOMs.
The candidate file comparator uses Memory VFS with a fully mapped, known empty
ancestor namespace; Memory is a fixture backend only. Missing access mappings
do not prove a native file is absent and produce an incomplete check.

The pinned dependency sources and MIT notices accompany the implementation.
Input, oracle sources, native output, shared build props and runtime character
facts are sealed by raw SHA-256 in `provenance.json`.

All recorded rule checks, file operations and full sequential cache projections
are compared against production implementations. This is bounded evidence for
the recorded inputs and pinned runtime facts.

This recording does not execute FindExtras/scanner integration, network errors,
symlinks, native multithreaded cache races, every CLR regex construct, HTTP/WS,
full scanning, migration or release acceptance.
