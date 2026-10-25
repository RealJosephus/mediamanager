# Comic book metadata and archive covers

Current provider, cover and saved-image tests use the
[same-run capture](../book-comic-current/README.md) and `current-profile.json`.
The recordings and provenance described below remain historical inputs with
their original identities.

`native.json` is copied byte for byte from `book-comic-native-5`. It contains 412 metadata observations (103 inputs through each of the actual ComicBookInfo, external ComicInfo, internal ComicInfo, and composite providers), plus 44 actual ComicImageProvider archive cases. The oracle executes the new designated-source build; its identity is distinct from the retained older reference build.

The metadata matrix covers reader precedence, exact XML names and namespaces, whitespace, entities, byte encodings, dates, language conversion, JSON scalar conversion and duplicate properties, credits, lookup errors, and cancellation. Archive cases cover actual ZIP, TAR, 7z, RAR4/RAR5, solid/encrypted RAR, GZip and rejected inputs, entry ordering, duplicate entries, Unicode Path extras, and original selected stream bytes. A ZIP stored under a CBR filename is explicitly a payload-detection case; it is not presented as genuine RAR evidence.

`provenance.json` binds the original execution, helper source and assembly, designated source/build closure, loaded managed assemblies, real generated inputs, decompressed entry files, selected cover streams, and unmodified upstream SharpCompress test assets. Upstream downloads have source URLs, a fixed source commit, Git blob verification, SHA-256 checksums, and the original MIT license. Previous attempts remain at their original paths with their qualifications; the first oracle attempt failed compilation and produced no native observations.

`book-comic-native-6` and `-7` independently repeat the two unusual RAR cases in fresh processes. Their selected streams differ from correct sequential extraction. The production implementation must derive the native selected stream from the archive input; recorded cover bytes are differential expectations only.

`image-consumer/` seals six additional actual consumer cases: normal RAR4, solid RAR5, and encrypted RAR4, each with local and internal saving. Actual ItemImageProvider, ProviderManager stream saving, ImageSaver, LibraryManager image refresh, ImageProcessor/Skia, and ItemPersistenceService execute against real files and SQLite. Both unusual streams are saved unchanged and receive persisted Primary image rows with zero dimensions and an empty blurhash. These are observable saved-state differences, not merely temporary decoder representations.

The consumer oracle controls unrelated host, configuration, and library-option interfaces. It does not run a complete native server or assert HTTP or final release acceptance. Its provenance includes exact source/configuration code, runtime/native libraries, SQLite databases, and saved-file hashes. Separate codec resource provenance records the explicit RAR4/RAR5 selected-entry adaptations and their source and license boundaries.

`rar4-entry/` retains a separate supplemental oracle: three normal/bad-payload-CRC/solid cases, seven empty/default/wrong-password/salt/cancellation controls, and three native compressed-stream observations. A nonencrypted bad payload CRC still returns the original selected image bytes. Fresh compressed RAR4 solid selection fails in the native decoder; a missing R4 salt selects the original packed stream rather than an invented decryption path. These inputs and recordings supplement the original 44-case raw file without replacing it.

`rar-directory/` adds 30 fresh native observations for RAR4/RAR5 separators, duplicate keys, directories, complete header order, fallback cover selection, and selected stream bytes. Nineteen RAR4 cases include all four Unicode filename decoder modes, copy and correction runs, UTF-8 fallback, replacement characters, and a malformed encoded name. Eleven RAR5 cases verify its distinct Windows separator conversion and the empty stream returned for a selected directory. Two unmodified upstream controls each retain all six entries. The bounded Node RAR4 header directory preserves duplicate names and sizes without inheriting libarchive's continuation heuristic; names are data and never become access paths. The initial 22-case recording and failing Node differential remain preserved separately.

Node tests use actual media VFS archive reads and independently mapped metadata sidecars. Production archive decoding runs in an operation-owned worker, with bounded reads and selected-entry spools. Native .NET is used only by the recorded oracle, never by the production implementation.
