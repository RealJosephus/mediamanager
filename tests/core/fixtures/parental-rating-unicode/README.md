# Native parental rating Unicode

The current release fixture executes the designated same-run LocalizationManager
after loading its embedded resources and actual BaseItem.UpdateRatingToItems on
BoxSet entities. It controls only server configuration and ordered Movie rating
inputs. It observes 63 rating scores and 23 final selections. FEFF/NEL/ASCII,
NumberStyles.Integer, nullable sorting, first-spelling, whitespace, NUL, slash,
and explicit-versus-default country prefix behavior are covered.

`current-profile.json` binds only the tracked scenario and the functional Oracle
under `current/`; the historical Oracle sources remain byte-for-byte unchanged.
The validation run records the current designated Native observation into an
isolated output, and consumer tests compare final rating selection, child
aggregation and actual CollectionService.add publication through a controlled repository/context
boundary, one queue/event and actual XML scalar serialization. They do not claim
full MetadataService, repository, streaming XML, HTTP or Web acceptance.

Node and PostgreSQL score validation cover all 63 samples through the raw native
text representation. A field-level exchange test carries `OfficialRating`,
`CustomRating`, `InheritedParentalRatingValue`, and
`InheritedParentalRatingSubValue` from SQLite to PostgreSQL and back, including
Unicode, NUL, SOH, a literal `\\u0000`, null, and empty values. PostgreSQL
`bytea` and returned SQLite TEXT cells are checked at raw-byte level. Child aggregation, queue and event checks
cover all 23 groups; XML succeeds for 22 representable groups and the NUL
selection is an explicit rejection.

The historical recording used a fresh isolated output and configured actual Jellyfin
assemblies and dotnet. Designated sources must match the isolated build source:

```text
node tools/compat/record-parental-rating-unicode.mjs NEW_OUTPUT_DIRECTORY ISOLATED_BUILD_SOURCE DESIGNATED_SOURCE
```

`native.json`, `provenance.json`, and the specialized recorder retain the
2026-10-14 observation unchanged as historical archive material. Its old external
runtime/build closure remains incomplete and is neither backfilled nor used by
the current release gate. Server ports and media are not opened. This focused
current identity does not make Native open or continue writing the exported
database, so it does not close the R7/R9 interchange contract, phase, or
full-release acceptance.
