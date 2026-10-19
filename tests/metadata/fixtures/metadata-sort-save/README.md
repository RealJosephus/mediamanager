# Native metadata sort mapping

The 23 controls execute the pinned BaseItemMapper entity-to-item and item-to-entity
methods with actual type-specific sort getters. Hydration assigns the stored
SortName before ForcedSortName; its setter invalidates the cache even when the
source names have not changed. The oracle inspects that cache before reading it
and projects the actual outgoing entity sort value.

Controls cover 15 native types, unchanged/empty/forced names, same-value setters,
cold Season/Episode/Audio number changes, Person rules and a supported Mandarin
spelling.
Provenance seals input, native output, source, project, build properties, DLL
and runtime. candidateVerified remains false.

Items have no Path, collection lookup is empty and recording lookup is inactive.
This excludes native SQL writes, a previously warmed cache, full refresh hooks,
provider/NFO behavior and file operations. Candidate SQLite/PostgreSQL separately
persist the projected fields and verify committed ItemUpdated sort values.
This fixture does not extend the portable romanization coverage or justify new
ICU/OS differences beyond the existing sort-name validation boundary.
