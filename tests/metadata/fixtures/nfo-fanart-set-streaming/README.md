# Native fanart/set NFO streaming fixture

This fixture records an independent NFO-reader boundary from Jellyfin commit
`208c278b75abd897aefa1e1175126eac5e4dbfaa`. The oracle invokes the actual
`MovieNfoParser` from the frozen Jellyfin assemblies over the exact UTF-8 bytes
recorded in `native.json`. `provenance.json` binds the input, output, oracle
source and project, relevant Jellyfin source files, assemblies, isolated
validation receipt, and the sealed candidate differential by SHA-256.

The 36 cases comprise six flat `thumb` cases, sixteen `fanart` cases, and
fourteen Movie `set` cases. They cover:

- `ReadElementContentAsString` look-ahead before a flat or nested thumb becomes
  observable, including malformed next tokens and truncated EOF;
- `fanart`'s exact-case recursive `ReadToDescendant("thumb")` search, its
  first-thumb-only rule, nested content rejection, explicit/dotted aspects,
  and a committed first thumb surviving a later malformed subtree;
- the `set` attribute being committed before `ReadInnerXml`, while collection
  content waits for the entire outer subtree and its following root token;
- direct text, CDATA, unknown subtrees, nested `<name>` failure, multiple names,
  and retention of an earlier name when a later name fails; and
- malformed or truncated nodes at each relevant boundary without converting a
  swallowed Movie XML error into a successful inner commit.

`candidate-differences.json` is the sealed before-implementation differential:
6 of the 36 cases differed from the production candidate. It is retained as
evidence that the fixture exposed real gaps; the test now requires zero current
differences in both synchronous and asynchronous production paths.
`candidateVerified` remains false because this is a focused reader boundary,
not a complete NFO acceptance suite.

The fixture does not establish local-image filesystem success/failure, every
URI scheme or `System.Uri` normalization, every XML 1.0 grammar/encoding case,
non-Movie parser families, Episode multi-block behavior, UserData persistence,
or every scalar/date/external-ID combination.

The isolated recording was produced with:

```text
node tools/validation/oracle.js tests/metadata/fixtures/nfo-fanart-set-streaming/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-fanart-set-streaming-20261008-v3 tests/metadata/fixtures/nfo-fanart-set-streaming/input.json {output}/native.json
```
