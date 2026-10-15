# NFO UserData persistence oracle

This fixture runs the pinned Jellyfin `MovieNfoParser` against the real
`UserDataManager` and an EF SQLite database. It records per-node transactions,
multi-key rollback, cache/item publication, synchronous events, event failure,
and cancellation observed after a committed event. A command interceptor also
fails the post-commit rehydrate SELECT: the database write and private cache
update survive, while `BaseItem.UserData` publication and the event do not.

It deliberately does not cover provider-host refresh, HTTP, NFO saving, or
other XML nodes. `candidateVerified=false` remains until the JavaScript
production path matches every recorded result in SQLite and PostgreSQL.
