# External item data cleanup

The pinned modified Jellyfin DLL executes actual `PathManager` and
`ExternalDataManager` for 16 controls. Each uses real isolated extracted
directories and actual EF SQLite repositories for keyframes, media segments,
Trickplay information and chapters. Ordinary files, dotfiles, DVD/BluRay,
stacked discs, channels, audio, pathless items, a read-only cache file and a
file at a cache-directory path establish path and filesystem behavior.

The recording includes files-only cleanup, a controlled segment-provider
failure and intercepted SQL failures at each of the four independent deletion
steps. Later failures retain earlier deletions. Application paths, library
options and the segment failure are controlled; the SQLite provider and all
four deletion implementations are real. The native SQLite library hash is
included in the output. No generated frames, encoding, full metadata refresh,
NFO writes, remote storage or generic item deletion are recorded.

Candidate tests compare paths, calls, files, preserved source bytes and target
and unrelated database rows on SQLite and real PostgreSQL. Instance cache
directories are real local state; media-side Trickplay directories and source
media use the test-only memory VFS. Additional controls exercise None refresh,
probe failure without duplicate pruning, stale snapshots and state junction
containment. Native recordings establish Windows behavior; other operating
systems and actual AList/WebDAV pruning still require separate evidence.

`provenance.json` seals input, oracle, project, native output, shared build
properties and the pinned native environment. `candidateVerified` remains
false in both native artifacts.
