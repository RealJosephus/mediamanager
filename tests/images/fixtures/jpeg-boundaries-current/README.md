# Independent JPEG decoder boundaries

This new input identity preserves thirteen JPEG sources from Actions input
generation 40097316850. It does not replace the original ten-image fixture or
reuse an old Native observation. The generation receipt and both producer
sources are preserved unchanged. The original validation ZIP remains in
`C:/mediamanager-validation/github-actions/40097316850/`.

Three JPEGs and two actual ICC profiles are exact members of the delivered
libjpeg-turbo/skcms source archives. Seven neutral pattern JPEGs were encoded in
Actions with the pinned libjpeg source, including four-component CMYK and actual
Adobe-transform-2 YCCK. The ICC inputs include Adobe RGB, FOGRA39 CMYK, a
mismatched color space and an explicitly malformed profile. The other sources
remove only EOI, truncate the scan in half, or corrupt the SOI marker. None of
these bytes were generated from an expected decoder result.

Four separately recorded aliases keep exactly the original bytes under supported
extensions: JPEG as PNG/WebP and an original PNG as JPEG/WebP. Decoding selects
the codec from its real header while the existing extension admission remains.

Actions generation 40101904994 separately supplies fourteen additional real
JPEGs in `scale-source/`, preserving all seventeen earlier sources unchanged.
For each n from 2 through 8 their actual widths are floor and ceil of
2048/(2n-1), and heights are floor(width*193/257). The canonical 128-pixel
source scale therefore straddles each n/8 midpoint using actual header sizes.
The neutral RGB pattern, source archive, recipes, licenses, declarations and
generation receipts remain unchanged source bytes. The original ZIP additionally
retains its actual compiler driver and producer binary; no compiler replay or
complete compiler closure is claimed by this fixture.

Two independent invocations instantiate the designated native ImageProcessor
with its actual SkiaEncoder and ManagedFileSystem. Application paths and server
configuration are controlled interfaces. Public image dimensions and complete
GetImageBlurHash values or failures are compared, including fourteen neutral-RGB
calls with cached Width/Height arguments differing from the actual image header.
These cached dimensions select the component count; actual header dimensions
govern decoding and both resizes. They do not trigger codec-scale midpoints.
No public expectation is inferred from an internal decoded buffer.

The strict public comparison now covers 31 sources and 14 cached-dimension
controls, totaling 45 actual method calls. All 48 original full, max128 and
float-midpoint decode requests and 28 additional real-source decodes remain
diagnostic observations with complete RGBA, raw SHA, per-channel pixel differences
and core hashes. They do not independently gate acceptance. The BlurHash consumer ignores
Alpha and consumes only RGB through its final public hash. Exception type names
also remain diagnostics. Caller bytes and normal stream/processor close remain
observed; no tolerance, forced recovery or release acceptance is implied.
