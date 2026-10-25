# Native FindExtras with .ignore and core resolution rules

The 14 samples execute the actual frozen `FindExtras` / `RefreshExtras` wrapper,
dedicated extra and audio resolvers, item lookup, `DeleteItem`, EF SQLite, state
files and events. The same actual `DotIgnoreIgnoreRule` instance is registered
for both root filtering and `ResolvePath`. Actual `CoreResolutionIgnoreRule`
also runs during resolution, with the application root explicitly controlled.

Cases cover empty/comment/invalid rules, root and ancestor exclusions, ordered
negation, the closest nested rule, Unicode boundaries and UTF-16 BOM decoding.
Numbering counts resolved candidates after filtering. Nested mixed counts retain
all files, including .ignore and excluded media. Ignored existing extras delete
their state files and database rows before cancelled owner provider dispatch;
their source media remain present.

The single-item provider does not save newly discovered entities. Collection
membership, saver dispatch, media sources and extracted file dispatch remain
controls. The comparator uses real SQLite and PostgreSQL, Memory VFS for media
and ignore files, and actual instance state files. Its full, known ancestor
namespace is available only to the ignore rule; it does not remap instance state
into media storage. Every selected column, complete stored Data, file hash,
dispatch, cache and event projection remains in the comparison.

All 14 recorded cases are compared on both database engines. Separate production
host checks cover incomplete ancestor rejection and cache isolation during D3
preview; those checks do not expand the native oracle's controlled scope.

This fixture does not prove the full metadata/provider/scanner pipeline, generic
deletion, network failures, symlinks, concurrent native cache access, every CLR
regex form, migration or release acceptance.
