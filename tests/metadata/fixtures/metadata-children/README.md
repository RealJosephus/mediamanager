# Native metadata child selection

The 15 controls execute the pinned services' `GetChildrenForMetadataUpdates`,
actual Folder recursive/linked traversal, Season.GetEpisodes, Series filtering,
typed Episode.Season getters and native LibraryManager.Sort with SortName and
AiredEpisodeOrder comparers.

They cover root-only links, duplicate handling, linked folders, AudioBook's Audio
inheritance, physical/by-name artists, BoxSet ordering, stale season IDs, grouped
presentation keys, specials, unknown seasons, dangling SeriesId, empty query
keys and query-only ancestors. Cached physical child lists, explicit ItemId
lookups and repository result arrays are controlled. The native query shape is
recorded, but EF translation, ownership filtering, artist relation SQL and query
ancestor loading are excluded. Candidate SQLite/PostgreSQL tests seed those
relations independently and exercise the production context loader.

The sealed provenance binds input, native output, source, project, build
properties and the pinned native runtime/DLL. `candidateVerified` remains false.
Legacy path-only linked children, channel episode retrieval, structural scans,
database child-query translation and full metadata lifecycle remain pending.
