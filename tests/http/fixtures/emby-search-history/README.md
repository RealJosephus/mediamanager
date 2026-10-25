# Official Emby search history observations

`reference.json` preserves selected HTTP records and read-only SQLite history
snapshots from the unmodified official Emby 4.10.1.0 package. The sources record
the release archive, capture producers, candidates, full observation hashes,
package/runtime stability and private instance cleanup. Original receipts and
logs remain in the linked workflow artifacts. No binaries or credentials are
included.

The history capture checks three scanned PCM WAV items, existing playback
state, current-user ownership, access restrictions, marking, clearing, copying
and restart. The order capture separates whole-second timestamp ties from
distinct timestamps. Its eight spaced queries demonstrate both directions,
ordinary offset/limit paging and a zero total when counting is disabled.
Earlier same-second responses alone cannot establish offset or direction
semantics. `WasSearched` in the POST body is unbound; even false or an invalid
string marks the supplied items.

The Node consumer uses real PostgreSQL, HTTP, WebSocket delivery and a database
close/reopen. It compares the query envelope, item identities/names and relevant
playback state with these observations, using an explicit Audio filter for the
controlled items. The original complete item responses remain available here;
this consumer does not claim complete Emby BaseItemDto compatibility, every
same-second query-plan tie, all item types or client UI acceptance. The history
scope uses native custom preferences so the existing SQLite exchange can retain
it without adding a business table.
