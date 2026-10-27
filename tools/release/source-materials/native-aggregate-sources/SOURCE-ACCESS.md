# Selected Sharp/libvips POSIX aggregate sources

This group supplies the nineteen additional complete native source containers
selected by the retained Sharp/libvips POSIX recipe at
`6e5971d333377743163edc3ad9e5d0b897abcbc9`. The original response containers
contain 84,811,451 compressed bytes, 17,236 regular files and eighteen symbolic
links. Seventy-two original notice, author, copyright and patent files are also
readable separately. Nothing has been repacked, transcoded or compiled.

`catalog.json` binds every original download URL, version variable, compressed
hash, complete member inventory, separately readable notice and acquired HTTP
receipt. Seven archive hashes also match the original Windows MXE package
recipes; that checksum association does not attribute the POSIX build to MXE.
Two original Google object metadata responses preserve published object sizes,
generations and MD5 checksums, libxml2 has its original published SHA-256
response, and Little CMS has the original release asset SHA-256 declaration.
Nine Git export containers additionally retain their original GitHub commit and
recursive tree responses. Fontconfig, Pixman and TIFF retain original Git commit
objects and complete trees fetched from their declared upstream repositories.
Their member blobs, executable markers, symlinks and gitlinks are checked
against those trees. Original export attributes explain the deliberately
omitted repository/CI control files in the Fontconfig, mozjpeg and zlib-ng
published exports; those original attribute files are supplied separately.

TIFF's original `*.ps1 text eol=crlf` attribute gives its published
`build/gitlab-ci.ps1` 325 CRLF line endings. That member is 9,857 bytes, while
the separately supplied original Git blob is 9,532 bytes with 325 LF endings.
The reader preserves both byte identities, validates the exact original
attribute and Git blob, and requires insertion of those 325 CR bytes to produce
the complete original archive member exactly. This declared single-file export
conversion does not normalize other source files or change the archive hash.

| Input | Exact version or revision | Original compressed bytes |
| --- | --- | ---: |
| AOM | 3.15.0 | 6,622,801 |
| libarchive | 3.8.9 | 6,617,696 |
| cgif | 0.5.3 | 40,021 |
| Expat | 2.8.3 | 517,264 |
| libffi | 3.8.0 | 1,581,626 |
| Fontconfig | 2.18.3 | 666,753 |
| FreeType | 2.14.3 | 2,515,533 |
| HarfBuzz | 14.3.1 | 37,889,473 |
| Highway | 1.4.0 | 3,691,240 |
| libimagequant, Lovell fork | 2.4.1 | 45,792 |
| Little CMS | 2.19.1 | 5,728,743 |
| mozjpeg | `08265790774cd0714832c9e675522acbe5581437` | 2,443,542 |
| Pixman | 0.46.4 | 827,198 |
| libpng | 1.6.58 | 1,592,190 |
| TIFF | 4.7.2 | 2,616,788 |
| Ultra HDR | 2.0.2 | 1,518,872 |
| WebP | 1.6.0 | 4,296,070 |
| libxml2 | 2.15.3 | 3,152,452 |
| zlib-ng | 2.3.3 | 2,447,397 |

These are current exact-version reads of the recipe's actual URLs, with
original redirect/response metadata. They are not recovered historical HTTP
responses. A source declaration or URL alone does not substitute for the
containers that are now supplied.

## Scope and existing inputs

The declared profiles are Linux x64 glibc and macOS arm64. The unchanged
`../recipes/sharp-libvips/build/posix.sh`, `versions.properties` and actual
platform toolchain files remain the source/build specification. The original
script builds these native inputs into a private prefix. The eight separately
supplied complete libraries in `../native-full-sources.json`, the complete
proxy-libintl 0.5 source in `../native-packages.json`, and the selected GLib GVDB
fallback in `../native-fallback-sources/gvdb` remain distinct original inputs.
Proxy-libintl is selected on macOS; glibc supplies Linux's corresponding libc
interface. Keeping its archive does not assert that it was linked on glibc.

The source reader derives the native download set from the actual original
recipe, subtracts those existing source groups, and requires exactly these
nineteen additional inputs. Changing or omitting a named selected source does
not become valid by repinning the new catalog. Its complete archive reading
streams regular member SHA-256/Git blob identities without extracting archive
paths or retaining whole decompressed containers. Original directories and
symlinks stay in the supplied containers.

The build flags matter. The recipe disables HEVC's libde265/x265, libarchive's
bzip2/lz4/zstd/lzma/lzo/OpenSSL/XML backends, FreeType's Brotli/bzip2, TIFF's
jbig/lerc/libdeflate/lzma/zstd, and libvips' JPEG XL/raw/PDF and other named
optional backends. Highway is selected for both profiles here. FreeType's
original optional `subprojects/dlg` gitlink is retained as an identity; the
recipe does not enable its debug logging implementation. Unselected tests,
examples, fuzz data and other platforms do not become additional native source
requirements merely because their declarations exist in a full archive.

Canvas's separate Skia dependencies and bundled Cargo AOM 3.11.0 do not
identify these Sharp constituents. Windows declares AOM 3.14.1 and uses the
separate MXE producer. The source instructions for the corresponding original
groups retain those distinctions.

## Ultra HDR source changes

The original recipe downloads PR 383 and then performs an inline CMake edit.
`ultrahdr-patch` supplies the current original PR/commit responses, current PR
patch response, and the immutable individual patch responses for:

1. `e2daed8da97d8857dcec2fd68d2f6f3326170f67`, removing platform/architecture
   detection and architecture-specific flags;
2. `7af35883ee575266cc43bbd05686734ebd5b1a82`, fixing ARM intrinsic selection
   when building on macOS.

The material reader requires the PR's ordered commit chain and exact diff
agreement with those fixed patch responses. It copies the original
`CMakeLists.txt` and `cmake/package.cmake` from the actual 2.0.2 container into
an owned working directory, runs `git apply --check` and applies each patch in
order, and finally replaces the single
`CMAKE_CROSSCOMPILING AND UHDR_ENABLE_INSTALL` expression with `FALSE`, as the
original recipe specifies. It fails on an absent or changed preimage, patch
failure, incomplete source, or cleanup failure. It records the resulting file
hashes separately from the pristine archive. This preparation does not compile
the library and does not claim that these current bytes recover the producer's
historical mutable download.

## Modify and recombine the actual runtime boundary

1. Preserve the original containers, catalogs, notices and recipes. Create an
   owned source/build workspace. Extract each container into its original
   root, preserving permissions and symlinks. Keep pristine sources separate
   from modifications. The `workingDirectory` field maps names such as
   mozjpeg to the recipe's `jpeg` directory.
2. Use the original platform configuration in
   `../recipes/sharp-libvips/platforms/linux-x64` or
   `../recipes/sharp-libvips/platforms/darwin-arm64v8`. Provide available
   compatible C/C++, Rust, Cargo/Cargo-C, Meson, CMake, Ninja/Make and assembler
   tools. There is no requirement to recover old compiler binaries or reproduce
   historical output bytes. For a current build working copy, replace the
   original macOS Rust bootstrap/install commands with those available tools
   and use Rust flags supported by that chosen toolchain; preserve the original
   script and record this current adaptation separately.
3. In that working copy, bind each original native `$CURL ... | tar ...`
   response to the matching supplied container, using the unchanged archive's
   local bytes as the extraction input. Bind fixed GLib, mozjpeg and libvips
   patches to the existing original patch files in `../recipes/patches`, and
   Ultra HDR to the two matching fixed commit patches above. Populate GLib's
   `subprojects/gvdb` from its exact supplied fallback before Meson runs.
   Apply the original recipe's source edits in order: Fontconfig's two inline
   edits, mozjpeg's SIMD patch and `JCP_FASTEST` edit, Ultra HDR's two patches
   and inline edit, librsvg's original manifest/Meson edits, and libvips'
   SONAME/static-aggregation/nodelete/symbol visibility changes. Build-option
   selections are not additional invented patches.
4. Build the original selected order into a separate private prefix; do not
   mix arbitrary host libraries into its pkg-config search. FreeType is built
   before HarfBuzz and rebuilt with HarfBuzz enabled. Resolve librsvg's actual
   effective Cargo workspace and normal/build source selection using its
   separately supplied current-profile evidence and source groups. The older
   observed 160 Rust containers alone do not prove this effective current
   POSIX graph; that remaining check is separate from these nineteen native
   archives. The original floating notice download can use the already held
   notice at the identified Sharp/libvips gitHead, explicitly recorded as a
   current source working-copy adaptation.
5. POSIX packages static constituents inside `libvips-cpp.so.8.18.6` or
   `libvips-cpp.8.18.6.dylib`. Rebuild that aggregate with the modified
   constituent and its selected dependencies. Installing an individual static
   archive beside the vendor shared library does not change the active code.
   If the Sharp binding also needs rebuilding, its exact locked npm source and
   `src/binding.gyp` are supplied in `dependency-cache`; relink it against the
   modified compatible prefix and retain the expected interface/loader names.
6. After ordinary delivery preparation, install the modified compatible
   library/binding into a separate runtime copy and exercise actual Sharp
   image/native consumers and application image operations. Keep changes,
   selected inputs, build records and functional results with that copy.
   Running the official `prepare.js` again recreates vendor bytes. Ordinary
   application startup does not enforce release-manifest binary equality.

This group closes the nineteen named native source-container gaps and supplies
the actual additional Ultra HDR source changes. It does not establish a
successful modified native compile/relink/runtime replacement. The POSIX
librsvg effective Rust graph and the current compatible Windows x64/shared
MXE/native build process retain their separate remaining scope. The existing
Windows Rust source graph is already supplied; it must not be described as
absent. No historical container/compiler replay, every optional dependency,
byte-identical old binary output or licensing compatibility conclusion is
introduced by this arrangement. Ordinary offline release installation gains
no Rust, native compiler or archive-tool prerequisite.
