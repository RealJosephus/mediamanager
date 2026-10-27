# Selected Skia native dependency sources

This directory supplies twelve complete original Gitiles source containers at
the precise revisions in the supplied Skia `DEPS`. Their 148,014,420 compressed
bytes contain 14,617 regular files (565,814,488 bytes), thirteen symbolic links
and the original directory entries. `../skia-dependency-sources.json` binds
their original URLs, SHA-256 values, raw Git commit objects, complete generated
Git/member catalogues, original nested gitlinks and forty separately readable
original notice/author/patent files. The containers have not been repacked.

| Dependency | Exact declared Git revision | Original compressed bytes |
| --- | --- | ---: |
| Brotli | `6d03dfbedda1615c4cba1211f8d81735575209c8` | 30,702,372 |
| Expat | `6154446fccefbf3ca644894f598969113b0c7bcd` | 8,442,021 |
| FreeType | `264b5fbf5b912b39f98d038bf75d39be0a73f21b` | 2,550,856 |
| HarfBuzz | `9cb1fee51069b206effb4736e443b038d230789d` | 37,302,870 |
| Highway | `457c891775a7397bdb0376bb1031e6e027af1c48` | 2,244,630 |
| ICU | `d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738` | 55,878,070 |
| libjpeg-turbo | `e14cbfaa85529d47f9f55b0f104a579c1061f9ad` | 2,623,868 |
| JPEG XL | `332feb17d17311c748445f7ee75c4fb55cc38530` | 1,928,508 |
| libpng | `d5515b5b8be3901aac04e5bd8bd5c89f287bcd33` | 1,612,853 |
| libwebp | `845d5476a866141ba35ac133f856fa62f0b7445f` | 3,813,319 |
| Wuffs C release | `e3f919ccfe3ef542cfc983a82146070258fb57f8` | 327,720 |
| zlib | `646b7f569718921d7d4b5b8e22572ff6c76f2596` | 587,333 |

These are current exact-commit acquisitions from the repositories actually
declared by Skia, rather than recovered historical producer downloads. The
raw commit objects were independently fetched from those repositories. The
reader hashes each commit, reconstructs every Git subtree and streams every
regular archive member's original Git blob. It also checks original symbolic
links, complete archive permissions and separately supplied notices. Git's
executable marker and the archive's full Unix permission metadata retain
their own meanings. Fractional PAX timestamps remain in the original bytes;
they are not rounded into a new historical timestamp model.

## Why these sources are selected

The bound Canvas `scripts/build-skia.js` selects the in-tree Expat, FreeType,
HarfBuzz, ICU, JPEG and WebP implementations and Wuffs. Its in-tree PNG/zlib
settings combine with the original Skia codec defaults. JPEG XL is enabled
for the three distributed targets (Linux x64 glibc, Windows x64 MSVC and
macOS arm64). Its original GN dependency file selects Brotli and Highway;
FreeType's explicitly enabled WOFF2 support also selects Brotli. The material
reader checks those actual source/configuration associations and the exact
root DEPS revisions before reading the containers.

The scope is these named source dependencies of the retained GN configuration.
It is not an independently recovered historical Skia asset-producer link map
or a claim that all files in a complete container were linked. For example,
source test/fuzz fonts and data remain in their original archives without
becoming runtime input requirements. Skia's DNG/raw path additionally requires
`skia_use_piex`, which the supplied Canvas script disables; a default DNG flag
alone does not select that dependency. Perfetto's tools dependency is not
selected by the script's disabled tools build. The other development, test,
tool, GPU and target-specific DEPS entries are not all source requirements
for the three declared bindings.

## Populate a source working copy and modify/recombine it

1. Preserve the original archives and verify each compressed SHA-256 from the
   catalog. Create a separate Skia working copy as described in
   `../skia-sources/SOURCE-ACCESS.md`.
2. Each Gitiles archive has paths relative to its repository root, without an
   extra release-directory wrapper. Unpack it into an empty
   `skia/third_party/externals/<name>` directory matching the catalog's exact
   `externalPath`. Preserve case, symlinks, original files, source headers and
   notices. The ICU container also supplies its original `common/icudtl.dat`
   and data-generation script used by the bound GN source.
3. Use the root Skia GN files and the producer changes described in the Skia
   source guide. Do not replace an external with a differently versioned
   constituent from Sharp, Canvas Cargo or a nested source container merely
   because its library name is the same. Record your own changes separately.
4. Build the affected static Skia aggregates, then relink the Canvas Rust/C++
   Node binding against them using the supplied original source/build inputs
   and an available compatible toolchain. Preserve the ten-static-library
   boundary and Windows ICU data handling. Replacing an embedded external
   requires that aggregate relink; the native binding does not load each
   embedded dependency as a separately replaceable shared library.
5. Install and exercise the modified binding in a separate prepared runtime
   copy, following the source guide's actual three platform member paths.
   Keep its source changes, selected dependencies and actual native/image
   consumer results distinct from vendor evidence.

FreeType's `subprojects/dlg` and JPEG XL's listed nested Git repositories are
preserved as their original gitlink identities and empty archive directories.
They are not source acquisitions for those nested repositories. The selected
Skia GN files use the separately supplied root Brotli/Highway/skcms source
paths rather than JPEG XL's standalone CMake dependency graph. Disabled
logging, standalone tests and other unselected nested builds do not become
mandatory inputs through these preserved gitlinks. A new configuration that
selects one must assess and supply that actual input and its notices.

The archives include all published source headers and named notices, with
forty additional readable original notice files. Read the actual per-file
grants and the original license/notice files; a manifest license expression
or another package's generic license text is not a substitute. Complete
Canvas Rust inputs, other applicable native/source responsibilities, a
successful modified aggregate build and final release acceptance remain
separately scoped. No old compiler distribution, historical runner replay,
byte-identical old binary output or licensing compatibility conclusion is
claimed or required by this acquisition.
