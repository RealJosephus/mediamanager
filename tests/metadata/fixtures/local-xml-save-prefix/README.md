The original native recording and provenance are immutable. `local-xml-stream.test.js` verifies the original recording bytes, the pinned native saver and filesystem source bytes, and the oracle source bytes before replaying the five saved file prefixes and bounded streaming/continuation behavior.

`local-xml-prefix-seal.test.js` additionally retains every original loaded-assembly SHA-256 check. Its strict input contract requires all those bytes. The original `Oracle.dll` with SHA-256 `5cb84efcdf5b2289998f499790b10117a353bfce589e22fcfb473cd588d7e2a4` has not been recovered; unavailable original binaries keep this historical seal unavailable. Passing the portable replay does not pass the historical seal or establish release acceptance.

Exact original-path-and-SHA-256 mappings in `tools/validation/recorded-inputs.json` identify relocated byte copies. They do not replace binary identities with a new native build, change any original pin, or supply an executable runtime.
