# Existing PhotoAlbum cover path boundaries

This separate three-case recording preserves the original 38-case
`photo-album-cover` recording and provenance unchanged. It runs the actual new
source-built native `PhotoAlbumImageProvider`, inherited
`BaseDynamicImageProvider`, `ManagedFileSystem.ContainsSubPath`, SQLite item
repository, and real file save path. Application/configuration/library interfaces
remain explicit isolated harness proxies; no complete native server is claimed.

The actual boundary results are:

| Existing cover spelling | HasChanged | Fetch | Item queries |
| --- | --- | --- | --- |
| Entire path uses forward separators | false | None (1) | 0 |
| Path equals the internal metadata root | false | None (1) | 0 |
| Internal root followed by `\..\sibling\old.png` | true | None + ImageUpdate (5) | 1 |

The comparison is a raw anchored prefix, requires a strictly longer child, and
does not normalize separators or dot segments. Storage access still enforces
the configured instance metadata boundary: the dot-segment fixture resolves
inside that separate metadata root.

`provenance.json` explicitly requires the actual compiled
`ManagedFileSystem.cs` and `BaseDynamicImageProvider.cs`, the complete original
source/build closure, loaded assembly hashes, helper source and inputs, raw
execution, and unchanged original 38-case raw/provenance. `native.json` is the
exact output from the new independent `photo-album-paths-native-1` execution.
