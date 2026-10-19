# Native parental rating Unicode

This fixture executes the actual LocalizationManager after loading its embedded
resources and actual BaseItem.UpdateRatingToItems on BoxSet entities. It controls
only server configuration and ordered Movie rating inputs. It observes 63 rating
scores and 23 final selections. All preceding 51 score and 21 selection samples
remain unchanged, including FEFF/NEL/ASCII, NumberStyles.Integer, nullable sorting,
first-spelling, whitespace and NUL controls. Twelve score samples and two final
selection controls cover slash inputs with only one effective nonempty entry,
multiple-entry controls, and explicit versus default country prefix handling.

The native recording keeps its raw score/null/nullable-subscore results as evidence.
Consumer tests compare final rating selection, child aggregation and actual
CollectionService.add publication through a controlled repository/context
boundary, one queue/event and actual XML scalar serialization. They do not claim
full MetadataService, repository, streaming XML, HTTP or Web acceptance.

Node score validation covers all 63 samples. PostgreSQL score validation covers
the 55 inputs its current text representation can store. The other eight samples
contain NUL: actual native GetRatingScore and SQLite can retain them, while the
current PG value encoder and PG text reject them. The explicit rejection test
records an unclosed R7/R9 native text gap, not R23 acceptance or full PG equality.
Consumer XML/event checks cover the 22 groups without unrepresentable PG NUL text;
the one original NUL selection group remains recorded and outside those checks.

Recording uses a fresh isolated output and requires configured actual Jellyfin
assemblies and dotnet. Designated sources must match the isolated build source:

```text
node tools/compat/record-parental-rating-unicode.mjs NEW_OUTPUT_DIRECTORY ISOLATED_BUILD_SOURCE DESIGNATED_SOURCE
```

The recorder captures the actually loaded DLLs, source/input/recorder hashes,
matching designated/build sources and stable before/after inputs. Server ports
and media are not opened. A complete build input closure and phase acceptance
are not claimed.
