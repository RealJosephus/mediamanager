# Item deletion across Native and PostgreSQL ownership

`tests/http/item-deletion-exchange.test.js` uses the current workflow's designated
Native build and stopped, initialized instance. It never reuses a historical
response as the expected result.

The test copies that instance into a new private root, removes the two documented
synthetic scaffold items before startup, and creates four PNG files from
`tests/images/fixtures/processor/single.png`. Actual Native HTTP creates a photo
library using the accepted `homevideos` collection option with `EnablePhotos`,
verifies its registered type and physical path, and runs its registered library
scan. The real resolver supplies the item
identities. HTTP metadata updates, image uploads and favorite requests establish
the business rows and assets. All scheduled triggers are disabled in this private
instance before the explicit scan.

Before the Favorite writes, the test opens a real authenticated Native WebSocket
using the copied producer's actual token, user and persisted device identity.
A real KeepAlive response establishes that the socket can consume messages. The
report retains every received and sent frame in full, including its original
bytes, parsed message and hash. Each successful Photo Favorite write must then
be observed in a subsequent `UserDataChanged` payload for that item and user
with the returned Favorite value. One frame may contain several writes, and
several frames may complete them. Unrelated messages and diagnostics are retained
without count, ordering or absence requirements.

The socket completes its actual close handshake before Native shutdown. This
barrier waits for the public consequences of this fixture's own writes; it does
not sleep for a notifier interval or inspect its private timer. The resulting
session and activity side effects remain in the complete SQLite snapshot and
subsequent PostgreSQL exchange. No rows are removed to hide them.

After Native has stopped, preparation adds one declared unknown `Data` member to
the fourth photo and one unrelated binary file under the private instance. These
are explicit opaque preservation inputs, not Native-produced business results.
Their exact original bytes are recorded before importing the complete database.

The chain is:

1. Import the stopped Native SQLite into a fresh PostgreSQL schema, comparing all
   31 business tables, insertion order, EF migration history and SQLite sequences.
2. Start Node through `startProductionInstance`, authenticate with the actual
   Native device, and request `DELETE /Items?ids=A,A,B`. The first deletion commits;
   the second occurrence returns 404; B, C and D retain their complete item rows
   and relations. The source and internal images of A disappear. Favorite data is
   retained with its original user/key/value and a retention timestamp.
3. Close Node, reopen PostgreSQL and export a full SQLite database. Require all
   business digests and envelope values to match. Every SQLite boundary contains
   exactly the 31 business tables and the two EF tables, with no held EF lock.
4. Install that export only in the stopped private Native root, preserving its
   same declared media and state assets. The real Native server reads A as absent,
   executes `DELETE /Items?ids=B,B,C`, and then edits C through HTTP. The duplicate
   failure responses are compared as public JSON, retaining the original bodies
   and projecting only each validated random trace ID.
5. Stop Native, import its complete returned database into another fresh
   PostgreSQL schema, compare the complete table and order digests, and start Node
   again. Both deleted items remain absent, C exposes the Native edit, D retains
   its entire raw `Data` TEXT, and the original favorites survive as retained or
   attached records.

Item snapshots inspect every modeled foreign key to `BaseItems`, both sides of
linked children, and the four cleanup tables without an item foreign key:
`CustomItemDisplayPreferences`, `ItemDisplayPreferences`, `MediaSegments` and
`TrickplayInfos`. The photo scenario requires actual Native-created ancestor,
image, provider, locked-field, item-value and user-data relations. Empty relation
families are recorded; they do not establish nonempty coverage of every family.

Source media, every initial image relation's real file, an unrelated sibling file
and the binary state asset are independently hashed at the ownership boundaries.
Only the intended deletion targets may disappear. This is a four-Photo exchange
scenario; it does not establish arbitrary Folder/owned/version deletion, a full
library, a complete state package, production scale or release acceptance.

Native shutdown must complete cleanly, release its PID and port, and leave no
pending SQLite journal bytes before a database copy or replacement. Node closes
before export and before any schema cleanup. Only the schemas created by this
test are dropped. If a runtime has not confirmed closure, its private files are
retained and the test fails. Published artifacts contain reports and logs with
credentials filtered; the private instance and databases are not published.

Required validation services are `dotnet`, `jellyfinDll`, `nativeInstance` and
`postgres`. GitHub Actions supplies `native_reference=true` and
`native_instance=true`; this test does not consume `native_sqlite`. Run the exact
test path on all three configured platforms. Validation reports record test results and acceptance status.
