# Current archive codec package and recovered sources

The codec package consumer binds the unchanged distributed WASM/JavaScript,
bridge, patches, notices and complete corresponding source files. It retains
four original SHA-256 pinned release archives and a complete Emscripten source
archive acquired at commit `ce6d2aad8bbf1e508e5a6d112f986617198bdc0d`. All 77
required Emscripten source/license members match their original recorded hashes;
the original toolchain commit remains unknown. This is source recovery, not a
claim that the old toolchain, link or compiled objects were reconstructed.

`source-offer.json` records 317 complete source/license identities and their
exact source archive members or recovered files. `source-reader.js` reads named
regular members directly from the complete retained archives without writing
archive names to host paths. The two modified RAR files are reconstructed from
the exact libarchive release and tracked patches. Zlib's capture name
`zconf.h.included` maps explicitly to the original `zconf.h` member with the same
full-file hash; no basename or approximate-content substitution is used.

The test preserves all 254 distributed notice sections against independently
recovered original source bytes, including complete license texts and every
declared source range. It also verifies the original linked-runtime source
attribution and the thirteen SharpCompress source files used by selected-entry
and filename behavior. `prepare_source_offer.py` packages only supplied exact
downloads and applies the two source patches; it never compiles or executes the
codec. Its download directory must contain the archive/file identities recorded
by this offer. Missing or mismatched source bytes remain an explicit failure.

The five existing resource/builder/wrapper records remain unchanged. Their old
prototype, link/relink, native helper, compiled-library and build-environment
paths are historical evidence, not runtime source files or inputs to this
consumer. Their records and original hashes remain reachable through
`historicalManifests`; no old execution is relabeled as newly passed.

Three retained original RAR4, RAR5 and LZMA2 byte vectors execute the published
WASM through the real BookArchiveService. The test checks selected JPEG bytes,
media lease release and spool cleanup, and writes an external package report.
These are known byte-vector checks, not a fresh Native differential. The
current Comic provider/cover consumers perform that separate comparison.
Neither this source recovery nor these package checks claim a complete build,
complete instance exchange, phase acceptance or release acceptance.
