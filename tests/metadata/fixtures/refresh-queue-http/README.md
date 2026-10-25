# HTTP refresh queue inputs

`native.json` preserves every byte of `../refresh-http-native.json` (SHA-256
`9aa3c645e9a6341c192d99a14ff7215e08b21b37de6c4dcd606f6a5b933b6418`).
The original recording remains unchanged.

`refresh-race-writer.mjs` is the existing independent PostgreSQL writer with only
its source import adjusted for this directory. Keeping these actual inputs
together prevents the test from claiming unrelated metadata fixtures as inputs.
