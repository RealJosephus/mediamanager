# Runtime ignore input scope

`native.json` is a byte-for-byte copy of
`tests/library/fixtures/global-scan/native.json` (SHA-256
`690f9fc6704493b1b7a6b7c761e52ac67d1e4c360dce74c2f3b5b5ee1af0c3de`).
The runtime integration consumes the recorded retrieval-failure and cancellation
outcomes. It does not rebuild the historical oracle or read its external files.

The original native output, provenance, and historical source/build seal remain
in `../global-scan/`. That provenance has SHA-256
`fe6be8d70295bafa4a84bdcbf64ebc0f979061cd17e242287ed0994def6d574d`
and identifies the original raw recording SHA-256
`079acd441188f2ab3be05f00f0b488afd8b8787a475dd492b5d71cb503162947`.
This copy is not a new native execution or a replacement for that seal.
