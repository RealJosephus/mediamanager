# Official Emby home section observations

`reference.json` retains 64 unchanged home-section HTTP records from the
isolated official Emby 4.10.1.0 server in run 39472216867. Its source binds the
original package, capture producers, complete observations, actual identities,
package/runtime stability and private process/instance cleanup. Full logs and
receipts remain in the linked artifact. No server binaries or credentials are
included.

`model.json` adds the unchanged 12-record model capture from run 39475686291.
It distinguishes string SortOrder values (including numeric coercion), nullable
boolean strings, the supported query fields, monitor values, premium/refresh
metadata and nested Unicode/NUL text info, including a second actual restart.

The metadata consumer checks section configuration, names, queries, arrays,
ordering, mode filtering, generated identity relationships, user ownership,
copying, deletion and restart with real PostgreSQL and HTTP. The original
server adds a contextual UserId to newly saved in-memory section objects and
omits it after reload/copy; it is retained in these raw records for diagnosis.
The metadata comparison uses persisted layout fields. Expanded ParentItem
comparison covers identity, name, type and collection type.

Fixture identities are rebound only in user routes, section IDs, declared
parent/library references, move/delete IDs and copy target users. Names,
TextInfo, unrelated Query values and unknown content stay literal. The layout
consumer compares complete Content-Type parameters and checks the actual PG
layout after saves, copy and cold reload for absence of contextual UserId.

The recorded section item queries, paging/count differences, complete item DTOs
and client UI remain separate consumers. A passing layout consumer alone does
not establish complete HomeSections or Emby 4.10 compatibility.
