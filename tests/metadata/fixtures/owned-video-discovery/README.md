# Owned video creation and missing-file lifecycle

This fixture calls the frozen workspace's actual `BaseItem.RefreshMetadata`,
`Video.RefreshedOwnedItems`, ordinary resolver, `LibraryManager.CreateItem`,
`DeleteItem`, and `ItemPersistenceService` over real files and EF SQLite.
The recording binds the original DLLs, exact oracle source and input bytes.

All owners are mixed, so this fixture does not cover `FindExtras`. The single
item provider records inherited entity/options/cancellation but performs no
save. Savers, collection membership, media source lists and external file
dispatch are controls; extracted file deletion itself uses real directories.
The selected row columns and complete stored Data are compared, together with
file hashes, events, independent SQL failure boundaries and parent caches.

The candidate uses real SQLite/PostgreSQL, Memory VFS media and real instance
state files. The VFS file creation time is a control. Read-only D3 destination
resolution is tracked separately from the native mutation trace. All 15 samples
are compared on both databases, including repeated dispatch on the same live
entity with a provider that performs no save. Production host regressions cover
creation before cancellation, live owner inheritance and writer preflight.
Neither a scoped comparison nor recording proves the complete scanner, general
deletion, FindExtras, network/provider saves, or final release acceptance.
