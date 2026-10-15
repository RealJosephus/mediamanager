# GetUserViews native contracts

`input.json` is the complete 54-case input recorded against frozen Jellyfin
source (two HTTP endpoints per case). `native-contract.json.gz` retains every
HTTP response, every before/after media row and all four filesystem domains.
Repeated rows and snapshots are interned losslessly; no contract field is
removed. The loader checks the pinned manifest, compressed bytes and the
semantic SHA-256 of each reconstructed complete source JSON.

`native-manifest.json` records the original raw file hashes, source directory,
stopped database hash, recorder hash, source DLL hash and isolated root. The
raw evidence remains under the manifest's source directory. The development
projection command is `node project-native-fixture.mjs <native-run-v4>`; it
refuses to overwrite artifacts or copy authentication records.

Tests construct a fresh database from the 13 initial media tables and create
two synthetic accounts with newly generated password hashes and recorded
actor IDs. No original user rows, password hashes, tokens or database file are
shipped. Initial filesystem domains contain directories only. Both SQLite
and PostgreSQL still compare all 108 HTTP responses, intermediate snapshots,
final media state, refresh failure state and resource cleanup. Native cached
Etag timing, cancellation/races, collage image generation and full phase
acceptance remain outside this fixture's verified coverage.

`native-labels.json` is a separate pinned projection of all 105 cultures and
the 12 view labels, with all 110 original resource/source digests. Its
generator verifies every original byte SHA before reading the selected keys.
Ordinary tests compare the complete selected key/value maps and the current
provenance against this independent frozen projection; they do not require
the ignored source tree or claim to rehash its bytes during offline tests.
