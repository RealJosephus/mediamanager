# Book / Photo resolver oracle

This fixture records the pinned Jellyfin `BookFileNameParser`, `BookResolver`, `PhotoResolver`, `PhotoAlbumResolver`, and `ResolverHelper` against real files. It freezes book parsing and directory collapse, photo format and artwork-prefix filtering, video-owned image detection (including the `.strm` / `.disc` boundary), `EnablePhotos`, resolver priority, and initialized item fields.

`native.json` was captured from Jellyfin commit `208c278b75abd897aefa1e1175126eac5e4dbfaa` with the isolated oracle record named in `provenance.json`. The JavaScript comparison exercises the production resolvers directly; SQLite and PostgreSQL scan persistence are covered separately by `directory-item-scan.test.js`.

This is resolver evidence, not a full `ValidateChildren`, metadata refresh, watcher, migration, or release-acceptance claim.
