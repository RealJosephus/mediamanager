# Studio HTTP inputs

The current designated Jellyfin process and Node/PostgreSQL receive the same
76 controlled entities and studio relations. The 44 HTTP observations cover
the Studio list and existing-name detail APIs, media-scope selection, name and
favorite filters, presentation-key representatives, null keys, ownership,
paging and disabled totals, library/rating access and actual binding errors.

ItemCounts deliberately include several media kinds, repeated media presentation
keys, an explicitly tagged episode of an already tagged series, an untagged
episode inherited from a series, and a Book contributing to the list's total.
The type filter chooses names; it does not narrow their returned counts.
Name-detail counts retain the separate native related-kind whitelist.

Each comparison records original HTTP and complete database/filesystem snapshots
before reads and after shutdown. Server identity, ProblemDetails trace identity,
equivalent 100 ns UTC formatting and the Studio Path under each isolated owned
program directory have declared projections; other fields and side effects
remain compared. This fixture does not claim newly created-name lifecycle or
other named controllers have passed.

Sources: the designated StudiosController, LibraryManager.GetStudios,
BaseItemRepository.ByName.GetItemValues/BuildItemCountsByCleanName,
ItemCountService.GetItemCountsForNameItems and RequestHelpers.CreateQueryResult.
