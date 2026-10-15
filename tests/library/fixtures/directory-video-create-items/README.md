# Native directory batch creation

The frozen actual LibraryManager resolves the directory items and then calls
CreateItems with real ItemPersistenceService/EF SQLite saves. The 60 scenes
retain all original resolved-item/dispatch/row/Data/link/file/cache/event fields,
full AncestorIds and BaseItemProviders, plus every one of the 72 EF mapped
BaseItems scalar columns. The preceding 52 results and successive 56/58 results remain unchanged with lossless Int64 guards.

The scenarios cover stacks, local versions, Folder fallback, ignore rules,
provider path attributes, inherited locks and DateAdded configuration, request
cancellation, empty batches, and real insert failures for the first row, a later
alternate and the link phase. Further scenes cover repeated batches, wrong-type independent deletion before cancellation, null-array exception priority, non-Library original events, null-parent and physical AggregateFolder parent chains. Time normalization follows native UTC-window and
candidate supplied-clock assertions. Other values and all full Data remain
exact; candidate media and known ancestor namespace are fixture controls.

Only MovieResolver and FolderResolver are registered. Collection membership,
providers, media source and external dispatch are controlled. This operation
does not refresh owned parts/extras or metadata, recursively ValidateChildren,
exercise the full resolver list, disc/network/concurrent-cache behavior,
migrate a full library, or establish release acceptance. The initial 52 scenes passed complete SQLite/PostgreSQL comparison and the
98-file strict run in stage 92ad6e1. Six new cases cover non-null live fields,
cleared fields and externally stale scalar columns/unknown stored Data.
Two further MediaUrl cases preserve Name, null entries and missing URL while
ignoring undeclared properties. All 60 scenes pass complete SQLite/PostgreSQL comparison in 121 tests after
recorded red/fix. Strict run records remain outside this sealed pack.
