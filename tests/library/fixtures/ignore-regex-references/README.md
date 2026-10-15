# Native ignore regex references

The oracle calls the actual frozen DotIgnoreIgnoreRule.CheckIgnoreRules with the
bound Ignore 0.2.1 and CLR Regex assemblies. Its 53 groups contain 309 checks for
ASCII and non-ASCII control escapes, numeric named references, capture
participation, forward and optional references, retained repeated captures,
alternatives, bracket/subtracted
classes, boundaries and case equivalences.

ECMAScript accepts unmatched references as empty. CLR rejects them. Production
uses the native reference matcher only when a rule contains references, retaining
the ordinary regex path for other rules. Inputs, source, native output, shared
props and the pinned character facts are sealed by raw SHA-256. Control escapes
use the ASCII control range; Unicode casing must not turn an invalid escape into
a valid one. The original 25 groups retain exactly the same native projections.

This fixture records matching only. It does not cover file/cache operations,
FindExtras, providers, complete CLR regex syntax, network/scanning or release
acceptance. The first 12-group capture and the expanded failure comparison remain
in the isolated validation outputs.
