# Warm item deletion HTTP oracle

This fixture uses the designated captured Jellyfin runtime's actual MVC LibraryController single/batch DELETE, AddJellyfinApi, binders, formatters and exception middleware with the same real LibraryManager/EF SQLite/file/cache/event lifecycle. Sixteen neutral Audio/Video/Folder/physical MusicArtist warm/cold cases first remove a persistence-only owned row through Playlist deletion, then call the actual HTTP endpoint.

Six warm Video/Folder/MusicArtist requests succeed with 204 and perform their logical cleanup/eviction. The other ten requests return 404. API-key principal/default policy, application paths, path protocol, collection-folder lookup, external cleanup and unused controller dependencies are explicit controls, not native authentication handlers or user-cleanup proof.

All initial/first/final 72-column frames, links, file hashes, lookup/deletion calls, cache states and event ordering are preserved. The native driver projects only its isolated root to $STATE; Data is parsed/re-emitted for that path projection, not claimed as raw SQL TEXT bytes. Candidate tests separately run the real Node HTTP application, PostgreSQL and mapped VFS media.

provenance.json binds input, driver, project, README, selected loaded assemblies, SDK host, source capture/build audit and two independent raw recordings. Only validated unique W3C traceId values in the raw body and its parsed jsonBody may be normalized by normalize.js. Status, content type, all other body bytes, state, files and calls must compare unchanged. An earlier diagnostic lacking W3C activity was rejected, not repaired by widening this normalization.

Repeat by building Oracle.csproj into a fresh isolated output directory, then invoking Oracle.dll with input.json, a new native.raw.json and a new state directory. Never overwrite a prior run or a frozen fixture.

Jellyfin-derived behavior is GPL-2.0-only. Complete designated build-input closure, native auth handlers, user cleanup, complete metadata/scanner, POSIX, clients and exchange/release acceptance remain outside scope. candidateVerified=false and completeBuildInputClosure=false are intentional.
