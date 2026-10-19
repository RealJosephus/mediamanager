# Dead Genre and Studio selectors

`Program.cs` runs the designated build's actual `BaseItemRepository.GetItems`
and EF SQLite queries against independent raw rows, values and a single map.
Seventeen queries cover Genre/MusicGenre, Studio, all types, combined predicates,
false and unset predicates, default owner/alternate/retention exclusions, locked
items, null and empty names, totals, and zero/offset pages. Explicit SortName
ordering keeps the requested order observable.

The counterexamples distinguish exact global ItemValues display names from
CleanName/CleanValue, case/accent normalization, item kinds and map membership.
An unmapped value can keep an item alive. A value of the other category cannot.
False and unset dead predicates impose no restriction. The raw recording stores
all 72 columns of every independent seeded row, plus selector values, returned ID and total, all loaded assembly hashes
and the SQLite runtime hash. The only controls are isolated application paths,
configuration, filesystem and virtual-path projection. No media or listening
port is opened. Source bindings and process results are in `provenance.json`;
the complete designated-build closure is not claimed.

`../../dead-by-name.test.js` compares all 17 queries in PostgreSQL using the
independent seeded rows. A separate 20,000-row fixture checks that SQL counts
19,000 dead items and returns one requested row without loading the candidate
set. These are internal repository predicates; this fixture does not implement
the post-scan validator, filesystem cleanup, bulk deletion or final release.

The behavior is derived from GPL-licensed Jellyfin sources identified by the
provenance paths and hashes. .NET and SQLite are development oracle inputs,
not production dependencies.
