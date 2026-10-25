# Pinned UTF.Unknown detector oracle

This recorder runs UTF.Unknown 2.7.0 loaded from the clean Jellyfin pin
`208c278b75abd897aefa1e1175126eac5e4dbfaa`. It records actual
`CharsetDetector.DetectFromBytes` and `DetectFromStream` (1024-byte reads),
including every returned detail's single-precision confidence bits, BOM flag,
detected label and nullable .NET encoding name. Inputs are neutral multilingual
strings encoded by .NET, explicit byte boundaries and deterministic binary data.
It does not execute a candidate or assert full playlist/release acceptance.

The same process mechanically exports the native model constants, in native
prober order, to a separate file. Those constants are implementation inputs,
not expected detector results. Reflection is validation-only; production uses
the JavaScript port and checked-in immutable tables. Upstream source and loaded
assembly hashes are sealed by `tools/compat/record-native-charset.mjs`.
