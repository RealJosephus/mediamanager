# Current NFO scalar, provider and layout comparison

`nfo-scalar-provider.test.js` executes the current oracle against the designated
Native runtime produced in the same GitHub Actions run. Its inputs retain all
69 original scenarios and all 207 CRLF, LF and BOM layout variants. The combined
276-case input is written into the run output and its digest is bound to the
Native capture. Native reads actual UTF-8 files; every file is checked against
its neutral input. Both Node `parseNfo` and `parseNfoAsync` consume all 276 cases,
giving 552 current comparisons.

Success or failure, HasMetadata, complete field and people values, ordered lists,
provider keys, scalar overwrite, dates with seven fractional digits, cancellation
prefixes and layout-sensitive outcomes remain in the comparison. Parsed fields
are also applied to a production Node item and its public SortName is consumed,
matching Native's public SortName under default server sort configuration.
Exception details remain raw diagnostics in the output.

`current-profile.json` binds both neutral input files, every current oracle
source, the project and shared build properties. The shared runner verifies the
same-run Native source/runtime closure and records scoped source bindings,
build/process logs, exact consumed scenarios and `.nfo` files, raw `native.json`
and `candidate-scalar-and-layout.json` under `nfo-scalar-provider-current-*/`.
Capture reports describe component execution and keep phase/release acceptance
false. The Actions test result supplies the comparison outcome.

The original fixture files and the original `reader-layouts` files remain
unchanged historical evidence. Current execution does not load their output,
provenance, repeat records or historical difference lists. The former
archive-only `native-repeat.test.js` is replaced by these current scalar and
partial-reader consumers. Full user-data transactions, provider discovery,
filesystem races, HTTP and release acceptance have separate evidence.
