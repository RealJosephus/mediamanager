# Native item cache oracle

This fixture executes the designated captured Jellyfin runtime's real LibraryManager constructor, RegisterItem and GetItemById, including its actual BitFaster.Caching 2.6.1 cache. Repository RetrieveItem and configuration are explicit controls. The neutral input covers 29 CLR entity types, four invalid capacities and seven mixed sequences, with 2428 ordered observations of values, repository reads, entries, exceptions and hot/warm/cold queue counts. No candidate implementation produces these expectations.

The native cache admits folders, videos, MusicArtist and LiveTvChannel; ordinary file leaves, other by-name items and LiveTvProgram are not registered. Capacity comes from ServerConfiguration. This is TU-Q, not an ordinary recency list; cold insertion alone need not displace a warm item. The Node port retains the upstream MIT attribution in src/library/bounded-item-cache.LICENSE. Candidate cache tests compare every recorded operation, and a separate real PostgreSQL test checks registration for the 28 currently implemented entity constructors. LiveTvChannel construction and deletion remain outside that candidate scope.

provenance.json binds this input, native output, driver, project, README, two independent raw recordings, loaded assemblies, SDK host and the designated source capture/build audit. Raw recordings must be byte-identical; there is no output normalization. Both reference capture and candidate tests remain scoped evidence, not release acceptance.

Repeat with a fresh isolated output directory using dotnet build on Oracle.csproj, then invoke Oracle.dll with input.json and the new native.raw.json path. Never overwrite a previous run or the frozen recording.

This does not execute native SQL/file deletion, metadata/provider saves, native authentication, a scanner, POSIX, clients or instance exchange. The designated source's complete evaluated/tool/environment/OS/Git build-input closure remains unproven. candidateVerified=false and completeBuildInputClosure=false are intentional.
