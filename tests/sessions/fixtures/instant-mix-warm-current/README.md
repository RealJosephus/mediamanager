# Remote InstantMix warm sources and sequential lookup

The same-run oracle executes the designated `SessionManager.SendPlayCommand`,
`MusicManager`, `LibraryManager` cache and name creation, EF SQLite repository
and persistence, and actual metadata directory creation. Each case has its own
SQLite database and instance root. A second capture starts fresh from the same
input; original commands, source rows, genre lookup/Added prefixes, artifacts
and executable receipts remain in the validation output.

The oracle freezes the complete pre-lookup EF BaseItems input, including the
model's detached-user-data placeholder, and the source row after each controlled
persistence-only mutation. PostgreSQL receives that input, warms the real
manager when requested, then applies the frozen mutation. Relation deletion uses
each real primary key. Node keeps its own explicitly recorded bootstrap rows;
their complete values are checked unchanged, and only those bound identities
are excluded from the source-row comparison. Full observations remain intact.

The candidate uses actual PostgreSQL, item creation, Local metadata storage,
HTTP routing and a real authenticated WebSocket. Thirteen cases cover cached
Album/Artist/Playlist/Movie sources after replacement or deletion, uncached
Audio/AudioBook lookup, duplicate source contributions, the order between
genre creation and a later genre source, and Guid.Empty after an already
committed creation. Failed delivery retains that prefix and a later command
recovers on the same runtime. Every case closes its runtime and owned schema.

Full command data is compared; independent random ordering is compared by
membership and multiplicity, with the audio source's first position checked
separately. The failed manager call is consumed by the actual Native production
exception middleware, whose full status, Content-Type and body are compared
with Node HTTP. Private exception messages remain diagnostic. The persistence comparison covers Id, Type, Name, Genres, CleanName
and Path. Native SQLite artifacts and candidate full rows are also retained,
without claiming a complete database or instance exchange comparison.

The Native transport is a controlled session sink and sessions are userless.
This slice does not establish Native HTTP/WebSocket, complete item DTO
projection, cross-user authorization, media playback or release acceptance.
