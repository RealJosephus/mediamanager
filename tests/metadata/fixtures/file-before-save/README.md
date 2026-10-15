# File changes before metadata saving

`Program.cs` invokes the pinned DLL's actual typed metadata services for 70
controls. They cover Movie, Video, MusicVideo, Trailer, Audio, AudioBook, Book,
Folder, Album, Artist, Series, Season, Episode, Photo, PhotoAlbum and
CollectionFolder file-change handling, the one-second threshold at tick
precision, metadata creation-date defaults and disabling, missing files,
metadata locks, reason flags and failures after presentation-key assignment.

Actual Movie/Audio/Folder/Album `RefreshMetadata` with actual `ProviderManager`
records None mode first and existing saves, size updates, external cleanup
failure and the logged final directory lookup failure. Configuration, file
metadata, empty child/repository results, File protocol, external-data and
repository callbacks are controlled. `ManagedFileSystem.GetFileSystemInfo`
also reads the actual isolated recording directory to establish its minimum
timestamps and four missing paths to record dotfile/extension/trailing-dot
existence guesses.
The actual `BaseItemMapper` also records SQL null dates becoming runtime
MinValue and mapping back to nullable columns.

The recording excludes ExternalDataManager internals, native SQL/NFO writes
and media file operations. Candidate tests use both SQLite and real PostgreSQL,
compare save callbacks and committed rows, and check existing keyframe pruning,
failure retention, VFS directory normalization and an additional controlled
Audio cancellation after its first save. Actual extracted-file, media segment,
trickplay and chapter cleanup is recorded separately in
[external-data](../external-data/README.md).

Raw fixture and oracle hashes, native DLL identity and runtime are sealed in
`provenance.json`. Both artifacts retain `candidateVerified: false`.
