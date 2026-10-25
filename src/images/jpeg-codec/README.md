# Portable scaled JPEG decoder sources

This directory supplies the complete libjpeg-turbo and skcms source archives,
licenses, a narrow byte-oriented C bridge and the fixed toolchain archive used
by `tools/images/build-jpeg-codec.py`. The build runs only through the dedicated
GitHub Actions workflow and creates a new WebAssembly module and JavaScript
loader. It does not replace any historical compiler or native recording identity.

The JPEG source revision comes from the DEPS of the designated Skia revision.
The skcms revision is the version recorded by the same Skia source tree, and its
compiled files match the vendored files. The full reference JPEG codec is kept
as source evidence with its BSD license, alongside the input, row decoding and
incomplete-image references; these reference sources are not linked into the runtime.

The bridge uses actual libjpeg scaled IDCT, default slow integer DCT and normal
upsampling to output packed RGBA rows. CMYK without a usable profile follows the
documented channel multiplication; valid matching ICC profiles use skcms to sRGB.
Malformed or mismatched profiles are ignored. Input exhaustion suspends decoding
without synthesizing an end marker. Complete decoded rows remain available and
unread rows are black. Header and decompression-start failures reject the operation.

The build's small module checks cover
invalid input and both original JPEG assets, without claiming Native parity.
The original ten-image and independent JPEG boundary differentials compare
complete public BlurHashes, dimensions, actual failures, cancellation and owner
close. Full normalized RGBA and per-channel differences remain diagnostics.

The supplied runtime is the unchanged output of Actions run `40099830198`.
`build-receipt.json` preserves that build's original identity and observations.
`runtime-source-offer.json` separately binds the delivered module and its complete
standard-library and JavaScript runtime source subtrees. These are exact members
of the original full compiler source archive, with only TAR ownership and time
metadata normalized. The original full archive remains in the build artifact.
The image processor's worker receives image bytes; its sole filesystem read is
the fixed packaged WASM URL. Each operation closes its worker before settling.

Every build preserves complete library archives, bridge/recipe bytes, compiler
runtime source, actual downloaded SDK hashes, source manifests before and after
compilation, individual commands and output hashes. The receipt identifies the
workflow candidate and runner. Binary SDK replay payloads are not included, and
the receipt does not claim a codec rebuild from an older recorded toolchain.
