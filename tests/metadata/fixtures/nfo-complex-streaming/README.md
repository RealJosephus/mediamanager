# Native complex NFO streaming fixture

This fixture records a second, independent NFO-reader boundary from Jellyfin
commit `208c278b75abd897aefa1e1175126eac5e4dbfaa`. The oracle invokes the actual
`MovieNfoParser`, `SeasonNfoParser`, and `SeriesNfoSeasonParser` from the frozen
Jellyfin assemblies over the exact UTF-8 bytes recorded in `native.json`. `provenance.json` binds the
input, output, oracle source and project, relevant Jellyfin source files,
assemblies, isolated validation receipt, and candidate diagnostic by SHA-256.

The 40 cases cover:

- an actor subtree committing immediately after its closing tag, even when the
  next root token is truncated, while a partial actor remains uncommitted;
- scalar `ReadElementContentAsString` behavior, including rejection of nested
  elements and the successful-next-token look-ahead required before assignment;
- the Series-season parser skipping all non-`namedseason` subtrees, and
  non-video `fileinfo/video` fields remaining untyped and uncommitted;
- field-by-field commits inside `ratings`, `fileinfo`, `streamdetails`, `video`,
  and `subtitle` subtrees when a later field or containing subtree is truncated;
- exact case-sensitive element and attribute matching, default versus prefixed
  namespace names, and undeclared or illegal namespace prefixes; and
- malformed XML names, duplicate lexical and expanded attributes, unquoted or
  illegal attribute content, invalid comments and character data, mismatched
  qualified tags, trailing text, and a second document root.

`candidate-differences.json` is the sealed before-implementation differential:
23 of the 40 cases differed from the production candidate. It is retained as
evidence that the fixture exposed real gaps; the test now requires zero current
differences. `candidateVerified` deliberately remains false because this is a
focused reader boundary, not a complete NFO acceptance suite.

The fixture does not establish every XML 1.0 grammar production or encoding,
local-image filesystem behavior, user-data persistence, Episode multi-block
merging, every scalar/date field, or every external-ID provider. In particular,
partial commits inside `fanart` and `set` complex subtrees remain outside this
stage.

The isolated recording was produced with:

```text
node tools/validation/oracle.js tests/metadata/fixtures/nfo-complex-streaming/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-complex-streaming-20261008-v6 tests/metadata/fixtures/nfo-complex-streaming/input.json {output}/native.json
```
