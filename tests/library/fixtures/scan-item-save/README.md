# Native scan item saves

The 24 controls run the pinned LibraryManager.CreateItems, GetCollectionFolders overload, SaveItems and EF SQLite persistence. Each supplied item identity is checked against the actual GetNewItemId with an explicit case-sensitive configuration. Parent/owner lookup, user-root child arrays, empty library options and identity path reversal are controlled callbacks.

The projection compares actual collection discovery, ancestor rows, all ItemValues and ItemValuesMap rows, five list columns, Data NULL policy and ItemAdded calls. Generated value GUIDs are replaced by their exact Type/Value identity. Seeded rows keep their recorded identities. The source item arrays keep case variants even though display columns use OrdinalIgnoreCase distinct values.

The candidate runs the same relation projection through metadata persistence in SQLite and real PostgreSQL for all 24 samples. Seventeen samples also run the real resolver pipeline and FolderScanService using a controlled resolver and Memory VFS. That scan projection compares creation and repeat-scan idempotence; it does not claim equivalence to native ValidateChildren enumeration or repeated native CreateItems events. Season/Episode hierarchy, owner-root, pre-existing stale ancestry and clearing controls use the direct save path only.

The fixture does not cover native filesystem enumeration, content-type/options selection, alternate versions, complete BaseItems/JSON bytes, other relation tables, deletion or a complete library. The oracle's candidateVerified remains false; strict candidate validation is recorded separately.
