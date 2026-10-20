# Internal metadata edits

The current designated native build executes the real UpdateItem controller
and recursive Children traversal for all six internal folder types. Controlled
lookup/save callbacks expose exact save order, lock propagation and editable
fields. Collection physical IDs include duplicates, a missing ID and a Movie;
nested collections, empty Playlist Children, top-level links, nested links,
linked folders and Aggregate virtual children distinguish traversal contracts.
Three requests per type cover lock, unlock and unchanged lock state. An
additional Series subject has an external linked Season: recursive locks
include it, while ordinary Series field propagation uses physical Children
and must neither rename that linked Season nor change its Tags. Its child is
also excluded from the root's non-recursive linked-child expansion.

The PostgreSQL consumer uses the actual HTTP endpoint, savers, persistence and
events, and checks unselected rows/relationships remain byte-for-byte intact.
This component oracle does not claim native HTTP or file-save equivalence.
Both source and controlled input are bound in each new oracle report.

The comparison binds DateCreated to its complete 100ns ticks, including the
seventh fractional digit; ISO and SQLite date spelling are equivalent here.
LockedFields retains exact membership and multiplicity. Its native callback
still holds the request array, while the candidate reloads an unordered
BaseItemMetadataFields relation (no ordinal column); only this relation's
enumeration order is projected. Save order, traversal, Genres/Tags order and all
other values remain strict. Candidate reports retain the unprojected fields,
database rows and relationships before and after every request.
