# Current charset selection and Playlist decoding

`current-profile.json` binds the neutral corpus and the same-run public detector
Oracle under `current/`. The current gate records all 662 byte samples with
buffer and stream detector observations, then compares the stream winner,
encoding label, BOM, 0.5 threshold decision, and final native `StreamReader`
decoded text consumed by the Playlist decoder. Candidate lists and confidence
values remain diagnostics. It does not compare private model layouts or export
model constants. The output retains the actual sample bytes, native results,
and build/run receipts. Playlist parsing, path resolution, files, and persistence
have their own consumer tests.

The original `native.json`, `provenance.json`, `Program.cs`, project, and
`README.md` remain unchanged historical archive material. Their unavailable old
runtime/source closure is not a current execution dependency and is not
reconstructed by the new observation.
