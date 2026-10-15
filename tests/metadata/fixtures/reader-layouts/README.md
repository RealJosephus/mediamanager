# Additional XML reader layout observations

These are fresh executions of the unchanged local-XML, NFO scalar, and NFO episode
oracles. `provenance.json` seals each input, raw native recording, comparison, and
external recorder result. The helper also verifies the oracle source, runtime,
reference DLL, and compiled oracle hashes. Original fixtures remain unchanged.

The inputs vary only whitespace between adjacent tags, LF/CRLF, and UTF-8 BOM.
Local XML has 246 equivalent cases and 24 counterexamples out of 270. Scalar NFO
has 207 equivalent cases. Episode NFO has 159 equivalent cases and 9 counterexamples
out of 168. Comparison removes only input labels and raw source bytes; fields,
ordering, errors, partial commits, and cancellation remain functional assertions.
Malformed suffixes can change the streaming commit prefix, so the counterexamples
must remain different. Self-closing and paired empty containers are never merged.

There is no writer replacement, whole-tree XML normalization, or cross-service
roundtrip acceptance in this fixture. Each passing candidate test checks the
actual reader behavior on these exact inputs.
