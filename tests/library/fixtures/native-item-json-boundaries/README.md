# Native item JsonDefaults boundary oracle

This fixture seals four independent executions of the pinned Jellyfin `JsonDefaults` codec in `Taipei Standard Time`: 67 executions of 44 unique input cases.

- `input.json`, `native.json`, and `record.json` are the original 23-case capture. `Program.cs` and `Oracle.csproj` are its exact source project.
- `input-r2.json`, `native-r2.json`, and `record-r2.json` are an additive 34-case capture. Its first 23 inputs are structurally identical to the original capture; the final 11 cover fractional DateTime Kind/offset behavior and double-format thresholds.
- `input-r3.json`, `native-r3.json`, and `record-r3.json` are the separate one-case capture proving that a JSON null token for nonnullable `VideoType` throws `System.Text.Json.JsonException`.
- `input-r4.json`, `native-r4.json`, and `record-r4.json` are nine duplicate-property cases for Int32, VideoType and DateTime. An invalid first or last occurrence throws; valid duplicates keep the final value. This capture reused the original sealed Oracle DLL without rebuilding. Its bytes came from `D:/mediamanager-validation/20261005/results/native-item-json-duplicate-properties-source-20261007`; the earlier three captures are unchanged.

The original bytes came from `D:/mediamanager-validation/20261005/results/native-item-json-boundaries-source-20261007`. `provenance.json` records the byte counts and SHA-256 hashes of every raw source, input, output, and execution record copied here.

The candidate test iterates all four input/output pairs. Successful cases compare semantic projections and the exact reserialized scalar JSON bytes. Failure cases compare only the behaviorally relevant exception family: a native top-level `System.Text.Json.JsonException` means constructor fallback, while the JavaScript implementation must raise its own `NativeItemJsonError`; it does not pretend to reproduce CLR exception identities or messages. The r4 verification gate was promoted only after the expanded comparison passed; the controlled pre-promotion run and its sole flag failure remain recorded in provenance.

This is a focused codec oracle. It does not replace the full-27 item persistence oracle, exercise PostgreSQL, or claim final release acceptance.
