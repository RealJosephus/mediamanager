# Library localization and SortName text resources

`user-view-labels.json` contains the 12 Movie/TV/folder menu labels selected from
105 frozen Jellyfin core cultures. Lookup uses the server's `UICulture`, native
resource-name/BCP-47 mapping, case-insensitive keys and the English fallback.
This is separate from per-request media-stream localization.

Regenerate with `node tests/library/extract-user-view-resources.js <source-root>`.
`user-view-labels-provenance.json` records the GPL-2.0-only license and SHA-256
digests of all 105 input dictionaries and five behavior sources. Tests verify
every selected value and digest; this does not prove complete HTTP behavior for
all cultures. Regeneration is a development operation, not a runtime dependency.

## SortName Unicode data

`sort-name-data.json` contains selected readable Unicode 10 / ICU 60 rules for
the frozen Jellyfin SortName contract. These are data, not a native library,
serialized ICU runtime, WASM module, or complete ICU rule interpreter.

`transliteration.js` uses the text mappings and explicit script/context rules.
The existing pure JavaScript `transliteration` dependency supplies the remaining
Indic, Thai and Bopomofo mappings. These still have documented phonetic and
context differences; this implementation does not claim general ICU equivalence.

The default SortName preprocessing, ASCII gate, UTF-16 numeric chunks and Person
special case remain in `dto.js`. Do not apply NFKC indiscriminately, strip all
symbols, or trim/collapse spaces after transliteration: those change the contract.
Original names and identity inputs are not modified by these resources.

Regenerate for review with `node tools/compat/generate-sort-name-data.mjs`.
The tool checks every input against the SHA-256 digests in
`sort-name-sources.json`, and prints the proposed text files as JSON to stdout.
It never downloads or runs platform binaries and is not part of product startup
or installation. Source changes require explicit review of the pinned digest,
regeneration and differential testing against the frozen Jellyfin oracle.

Unicode's license is in `sort-name-unicode-license.txt`. The source ledger also
identifies the text rules used by the handwritten context algorithms.
