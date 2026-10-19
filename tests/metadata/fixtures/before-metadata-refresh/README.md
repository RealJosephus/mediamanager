# Refresh hook and sort cache oracle

This recording invokes the pinned modified Jellyfin assemblies. It has 182
controls for actual BaseItem, Movie, MusicVideo, Trailer, Series and Season
refresh hooks, native SeasonPathParser, actual LibraryManager.ParseName and
native BaseItemMapper after a warmed sort getter. Pathless MovieMetadataService
controls use actual ProviderManager discovery and record the first save,
selected lookup, final save, reattachment count and cancellation. Six actual
EpisodeMetadataService controls compare provider reads of a warm sort cache,
index mutation, same-value name setters, no-save completion and cancellation.

Library entities, options, file information, provider enablement, empty remote
results, episode-number no-change callbacks and persistence callbacks are controlled. No native SQL, NFO or media
file operations occur. Episode naming and embedded tags, rebasing by-name state
paths, specialized service After hooks and complete library refresh are outside
this recording. Candidate tests additionally use SQLite and real PostgreSQL.

Raw inputs, output, C# source, project and shared build properties are sealed in
`provenance.json`. The native recorder keeps `candidateVerified: false`.
