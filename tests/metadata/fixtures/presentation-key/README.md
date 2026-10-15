# Frozen presentation-key controls

`native.json` is an unchanged actual DLL recording from
`.agent-docs/evidence/presentation-key-native-v5/native-fixed.json`.
SHA-256: `a71ce54be60a852b9e3a2c969cde20db4d9f79b58bb3acc37636169542fd8115`.

The 80 direct controls call every frozen entity virtual-method override:
generic ID, Video primary-version IDs including Guid.Empty, by-name accented
names, MusicArtist, Series grouping/provider/language/library combinations,
and Season stored-series keys with absent/negative/large indexes. The 24
actual Movie/Person metadata-service controls cover first/existing items,
None/Default refresh modes and missing/stale/correct keys.

Five context controls additionally call actual LibraryManager.GetCollectionFolders,
GetLibraryOptions, BaseItem preferred-language/country methods, and virtual keys.
An uninitialized LibraryManager receives a controlled cached UserRootFolder;
parent lookups and cached CollectionFolder options are controlled. First-library
missing options are represented by cached default LibraryOptions. Conflicting
query AncestorIds/TopParentId are repository-only input descriptors, not entity
properties or native SQL. The controls cover unrelated query ancestors, real
parent language, default first-library options despite a configured second
library, no actual library, and a CollectionFolder's own options.

Options, collections, parent series, provider and repository dependencies are
controlled. Native repository calls execute no SQL and leave DateLastSaved
at MinValue. Candidate tests compare the recorded first-refresh
ReattachUserData callback in sequence and independently verify real
SQLite/PostgreSQL commits and library/series context. Native reattachment SQL,
other refresh hooks, complete native SQL/HTTP and lifecycle/race acceptance
remain outside this fixture's scope.

The candidate key-save consumer supplies a current instance directory for each
Person. Path is excluded from this recording's projection; current/old paths,
rebase hooks, real virtual-path reversal and EF saves are independently compared
by the by-name-refresh fixture. A null path must not be used to bypass those
production hooks.
