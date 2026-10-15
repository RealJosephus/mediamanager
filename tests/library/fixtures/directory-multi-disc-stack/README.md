# Native multi-disc directory stacks

Nineteen scenes run the frozen `LibraryManager.ResolvePaths` and
`MovieResolver.GetMultiDiscMovie` path against real nested files. They record
DVD detection through direct `video_ts.ifo` and `VIDEO_TS` VOBs, Blu-ray
`BDMV`, the `Disc`, `CD`, `DVD`, and `disk` stack tokens, numeric and
alphabetic parts, extension-like directory suffixes, and the captured ASCII
numeric path order (including the non-padded `1`, `10`, `2` result). A
`Film_Disc 1` versus `Film-Disc 2` scene freezes the observed CurrentCulture
punctuation order that selects Path, identity and `AdditionalParts`; the
recording also stores `CultureInfo.CurrentCulture`, `CompareInfo.Name` and the
comparison result. Broader case/non-ASCII and Windows NLS versus Node ICU
ordering remain deliberately unclaimed.

The projection keeps the complete resolved entity, dispatch calls, unchanged
EF rows and Data, links, files, cache flags, IDs, types, names, paths,
`VideoType`, and `AdditionalParts`. It proves that a valid stack is one
non-folder Movie, MusicVideo, or Video whose deterministic identity and Path
come from the first sorted disc directory. Remaining qualified directories are
stored only in `AdditionalParts`; the outer container and additional discs are
not separate resolved items.

Strong invalid layouts preserve native Folder fallback: one qualifying disc,
unrelated names, mixed `Disc`/`CD` tokens, mixed numeric/alphabetic parts,
mixed DVD/Blu-ray formats, and a direct video beside a directory stack. An
unqualified sibling directory is ignored. The native qualified-stray edge is
also retained: when exactly one stack exists, every sorted qualified directory
is included in `AdditionalParts`, even a directory outside that stack.

Only MovieResolver and FolderResolver are registered. Resolution does not save
or recursively scan items. Candidate tests separately exercise real SQLite and
PostgreSQL scan persistence, stable rescans, weak-snapshot withholding, and
fail-closed reverse reclassification. DeleteItem source deletion, removal of a
missing multi-disc stack, primary-disc promotion, arbitrary resolver types,
metadata refresh, migration, clients, performance, and release acceptance are
outside this fixture.
