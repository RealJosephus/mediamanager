# Native resolver entity types

This fixture records the exact fifteen CLR entity types reachable through the
candidate's production directory resolvers, persistence, and hydration
registry. There are sixteen independent cases because `MusicArtist` is
recorded once under a physical parent and once as a by-name item with an empty
parent ID. AudioBook, Book, Photo, and PhotoAlbum are included in the same constructor and
round-trip boundary as the pre-existing video, TV, and music types.

The frozen recorder uses the real public constructor, `BaseItemMapper.Map`,
`ItemPersistenceService.SaveItems`, EF SQLite reload, and
`BaseItemMapper.DeserializeBaseItem`. Every case retains the fresh constructor
projection, the controlled live entity, all 72 mapped and stored `BaseItems`
columns, the complete JSON-or-NULL `Data` value, the hydrated entity, and the
complete subject ancestor/provider/value/lock/trailer/image/link relations.
The parent chain and linked alternate are deterministic controls.

The typed projections also preserve the native Folder state distinction. A
fresh constructor and the controlled live resolver object have
`DateLastMediaAdded == null` and an empty-but-unloaded linked-child list. The
Folder setter marks even an assigned empty list as loaded, while cold mapper
hydration yields `DateTime.MinValue` for the absent database date and a loaded
empty linked-child set. These values are recorded independently in the
constructor, resolved-live, and lookup projections.

`Data` is compared twice. The parsed object is compared in full without
filtering or deleting keys. The raw compact JSON text is also retained and
compared exactly after replacing the escaped controlled state root with
`$STATE`; that second comparison intentionally seals native property order,
GUID N formatting, null omission, and JSON escaping. Database GUID, date,
enum, binary blur-hash, and random `ItemValues` identifiers are normalized only
to their corresponding frozen semantic representation.

The candidate differential independently constructs its inputs from
`input.json` and fixed recorder constants. It uses the production exact-type
factory, the real metadata-context draft loader, `ItemCreationService.saveItems`,
real SQLite/PostgreSQL storage, and a cold `getItemById` hydration. The native
golden is used only as the expected result, never to manufacture candidate
input.

This is deliberately a narrow persistence and hydration oracle. The native
capture does not execute a filesystem resolver, `LibraryManager.CreateItems`
cache/events, `Folder.ValidateChildren`, metadata providers, recursive scans,
native PostgreSQL, faults/cancellation, migration, HTTP, or final release
acceptance. The existing directory creation and validation packs retain those
separate responsibilities.

The scoped seal passed its focused 52/52 candidate comparison against real
SQLite and PostgreSQL. This is candidate verification only for the narrow
boundary above, not phase or release acceptance.
