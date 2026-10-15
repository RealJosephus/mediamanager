# Native NFO scalar, date and provider matrix

This fixture records the pinned Jellyfin NFO parsers at commit
`208c278b75abd897aefa1e1175126eac5e4dbfaa` through the actual release DLLs.
The oracle reads 69 exact UTF-8 files and projects the item and people state
even when parsing throws. Each input controls its parser type, available
external-ID keys, release-date format and pre-cancellation state.

The matrix covers all parser dispatches used by the candidate:

- `MovieNfoParser` for `Movie`, `Video` and `MusicVideo`, including `<id>`,
  movie `<set>`, music-video artist/album, aspect ratio and URL-tail type gates;
- `SeriesNfoParser` fields `<id>`, `airs_dayofweek`, `airs_time`, `status` and
  `displayorder`, including the deliberate `namedseason` skip;
- `SeasonNfoParser` fields `seasonname` and `seasonnumber`;
- `SeriesNfoSeasonParser` matching/non-matching `namedseason` and its rule that
  every other field is discarded;
- `EpisodeNfoParser` numbering aliases, show title and common scalar dispatch
  in one complete block (multi-block behavior remains owned by the dedicated
  episode-block fixture); and
- generic `BaseNfoParser<MusicAlbum>` and `BaseNfoParser<MusicArtist>` behavior.

The common-field combinations cover normalized and empty repeated strings;
CLR-only whitespace; lock state and named/numeric/invalid `lockedfields`;
studios, genres, styles, tags and countries; runtime/year/rating numeric
grammar and preservation; director/writer/credits separators; and the complete
current `PersonKind` enum boundary. The actor matrix additionally locks CLR
`Enum.TryParse` semantics for defined and undefined Int32 numerics, negative
values, named comma composites, rejected named/numeric and numeric/numeric
composites, invalid components, Int32 extrema and overflow. Date cases lock
all seven 100ns fractional digits (including one tick), zero-fraction
canonicalization, invariant parsing, and fractional ticks through explicit
offset conversion. The remaining common cases cover YouTube trailer
conversion/deduplication, default and custom exact release-date integration,
UTC offsets crossing year boundaries, and `ProductionYear` precedence.
Provider cases cover configured direct nodes, case-insensitive
node lookup, aliases, empty/missing/custom `<uniqueid>`, built-in validators,
MusicBrainz GUID forms, movie/series `<id>` rules, provider availability, and
ordinal URL scanning for every URL-capable item type.

The cancellation/error cases distinguish self-closing roots, paired-empty
roots, direct root text, strict malformed setup, URL-only malformed input,
provider URL work before cancellation, and attribute/provider prefix commits.
The candidate test runs every frozen result through both `parseNfo` and
`parseNfoAsync`, giving 138 exact comparisons. `candidate-differences.json`
seals two pre-fix captures: 24 sync/async records across 12 scenarios from the
initial audit, plus 26 records across 13 scenarios from the PersonKind/tick
precision follow-up. That is 50 records and 25 capture-scenarios across 24
distinct inputs; it is diagnostic evidence, not an allowlist.

Deliberate exclusions avoid claiming or duplicating broader coverage:

- `nfo-date-format` owns custom format token grammar and exhaustive leap,
  fraction, offset, min/max and invalid date values;
- `nfo-complex-streaming` owns ratings/fileinfo child streaming, namespaces
  and detailed XML-name boundaries;
- `nfo-partial-reader` owns generic malformed XML, encoding/raw-byte variants,
  and user-data save/failure ordering;
- `nfo-episode-blocks` owns zero/one/multi complete episode blocks, stable
  sorting, winner replay, merge/discard and Episode cancellation/user data;
- `nfo-local-images` and `nfo-fanart-set-streaming` own thumb/fanart URI,
  filesystem and nested-set streaming behavior.

This stage does not cover full XML 1.0/DTD/declaration/encoding behavior,
provider plugins outside the controlled external-ID set, provider discovery
and file IO races, logging, or real user-data/database transactions. Therefore
both `native.json` and `provenance.json` intentionally retain
`candidateVerified: false`.

The isolated recording command was:

```text
node tools/validation/oracle.js tests/metadata/fixtures/nfo-scalar-provider/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-scalar-provider-20261008-v6 tests/metadata/fixtures/nfo-scalar-provider/input.json {output}/native.json
```
