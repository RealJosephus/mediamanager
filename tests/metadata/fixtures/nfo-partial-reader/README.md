# Native partial NFO reader fixture

This fixture records the current native NFO reader boundary independently of
the sealed `nfo-partial-file-lifecycle` saver fixture. It is tied to Jellyfin
commit `208c278b75abd897aefa1e1175126eac5e4dbfaa`, hashes every relevant parser
source, and records the exact DLL, oracle build, raw input bytes, and isolated
validation receipt in `provenance.json`.

The 41 first-stage cases cover:

- swallowed versus propagated XML errors for Movie, Video, MusicVideo,
  Series, SeriesNfoSeason, Episode, Season, MusicAlbum, and MusicArtist;
- scalar look-ahead commit points, complete/partial actors, `<id>` attributes,
  `<set>` attributes, and `<uniqueid>` content;
- Episode files with no complete block, one complete block plus a residual
  tail, valid reordered multi-block input, and a malformed later complete
  block;
- undeclared entities, literal NUL, accepted numeric control/surrogate
  references, an out-of-range numeric reference, malformed UTF-8 replacement,
  UTF-8/16/32 BOMs, no-BOM UTF-16, and an encoding declaration after decoding;
- provider URLs after XML or without XML; and
- user-data lookup/save order for empty and existing item IDs, the
  non-cancellable save token, cancellation observed at the next XML node, and
  a failure on the second save.

`native.json` is oracle output. `candidate-differences.json` is the sealed
phase-one diagnostic captured before the pull reader was implemented, not an
expected-failure allowlist. The candidate test now requires production code to
match all 41 recorded results and also asserts that the historical diagnostic
contained 26 real gaps. `candidateVerified` remains false because the sealed
oracle/provenance files describe only this first-stage boundary; they have not
been promoted into a broader reader acceptance fixture.

This stage does not establish local image filesystem behavior, the exhaustive
ratings/fileinfo/scalar matrix, real user-data database transactions or emitted
events, provider file-discovery IO handling, every date format, or every
external-ID provider. In particular, direct complex children are still built
atomically by the candidate reader: final-complete actor nodes, nested content
inside scalar nodes, and field-by-field truncation within ratings/fileinfo need
a separate native fixture before that streaming boundary can be accepted.
Those omissions are also embedded in `native.json`.

The isolated recording was produced with:

```text
node tools/validation/oracle.js tests/metadata/fixtures/nfo-partial-reader/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-partial-reader-20261008-v4 tests/metadata/fixtures/nfo-partial-reader/input.json {output}/native.json
```
