# PhotoAlbum cover differential

`native.json` is the byte-for-byte output of actual native execution 8 under
`D:/mediamanager-validation/20261016-photo-stage/results/photo-album-native-8`.
It runs the new designated-source build (`jellyfin.dll` SHA-256
`474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26`),
distinct from the retained older baseline. `provenance.json` binds the helper,
input, original pictures, actual loaded assemblies, copied compiled source,
raw execution, and complete source/build closure. Earlier failed and superseded
helper attempts remain independently recorded; no expected Node output was
used to produce the native recording.

The helper executes the real `PhotoAlbumImageProvider`, inherited
`BaseFolderImageProvider`, SQLite `BaseItemRepository`, `ProviderManager` file
save overload, and `ImageSaver`. It supplies isolated application paths and
interface proxies. Recursive parent normalization invokes the real private
`LibraryManager.SetTopParentIdsOrAncestors` implementation directly on a host
without runtime fields: this PhotoAlbum branch depends only on static ancestor
normalization. This component fixture does not claim a complete native server.

The 38 scenarios cover leaf/folder and recursive ancestor selection, stale or
missing relations, first selected item/image retention, remote and invalid
paths, unknown and non-image MIME, duplicate Primary images, owned and alternate
versions, null sorting, GUID ordering, typed zero references, external existing
covers, internal timestamps/missing files, actual cancellation truncation,
destination failure, old-image deletion failure, and temporary source cleanup.

The PostgreSQL tests seed full native row snapshots into fresh isolated schemas
using a pool of one. The provider returns at most one narrow SQL row and copies
original bytes through media, metadata, and temporary storage mappings. Further
consumer tests exercise 20,000 descendants, independent media/sidecar mappings,
actual image persistence, actual HTTP original bytes and MIME, persistence
failure prefixes, and partial runtime configuration.

Re-record only into a new external evidence directory with the actual helper
and declared input; never reconstruct a raw native recording from assertions.
