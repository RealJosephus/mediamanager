# Canvas's Skia source, changes and recombination boundary

This directory supplies the complete original Skia Git source archive at
`a9c42c9fce77cd748805df0ec67ef5718800b1e9`, the exact `skia` gitlink in the
held Canvas source at `b2723ffae4e74e8c9df752902b137ec4061530e9`.
`../skia-sources.json` records its original GitHub URL, 79,689,406 compressed
bytes, SHA-256, complete recursive Git tree and actual archive members. The
archive preserves 12,396 regular files (189,179,495 bytes), its original
directories and its one symbolic link. It has not been repacked.

Ten separately readable original notice/author files and eighteen original
build/selection files are provided for inspection. All original source
headers and other files remain in the complete archive. Auxiliary files and
disabled modules are included without claiming that they were linked into
the three distributed Canvas native bindings. The catalog's source reader
reconstructs every Git subtree and streams each regular file's original Git
blob, verifies the symbolic-link target and preserves the original notices.
It does not extract paths or execute the supplied code during packaging.

## Read and prepare separate sources

1. Verify the named compressed archive's SHA-256 from the catalog. Unpack it
   with a gzip/TAR reader in an empty directory you own. Preserve the pristine
   archive and source separately from a working copy. A filesystem used for
   compilation must preserve original case-sensitive names and symlinks.
2. The source root becomes the `skia` directory next to the supplied Canvas
   `src`, `skia-c`, `build.rs` and `Cargo.toml` working copies. Their original
   sources and build inputs remain under `../recipes/canvas` and are bound by
   `../native-packages.json`. Preserve their original MIT notice.
3. Populate only the external inputs required by the chosen GN build at the
   exact revisions declared in Skia's original `DEPS`. An input which has not
   been supplied by this release must be acquired and retained separately;
   a URL or Git identity alone is not possession of its source or notices.
   The twelve selected codec/text own-source containers are supplied under
   `../skia-dependency-sources`; follow that source guide's exact external
   directory mapping and nested-gitlink boundaries.
   Inspect the matching `third_party/*/BUILD.gn` files for effective selection.
   The development/test/tool entries in the full DEPS list are not all runtime
   constituents or automatically part of a source requirement.
4. Use an available compatible C/C++/Rust toolchain and GN/Ninja. The supplied
   manifests retain the producer's requests and flags. They are build
   specifications, not a requirement to acquire old compiler binaries,
   reconstruct a historical runner or produce byte-identical vendor output.

The original source symlink at `src/ports/fontations/Cargo.toml` points to
`../../../bazel/external/fontations/Cargo.toml`. It is preserved, rather than
flattened or redirected outside the source. Fontations and Rust image decoders
default to disabled in the supplied `gn/skia.gni`; the source's presence does
not select every Rust workspace or Bazel dependency.

## Apply the actual Canvas source changes

Read the original `../recipes/canvas/scripts/build-skia.js` before modifying
the working Skia tree. The supplied `build-files` retain the original affected
Skia files without those producer changes.

| Source | Producer behavior | Scope |
| --- | --- | --- |
| `third_party/highway/BUILD.gn` | Insert `hwy/per_target.cc` immediately before the existing `hwy/targets.cc` source. | All targets selected by this script. |
| `third_party/icu/SkLoadICU.cpp` | Change ICU data search from executable-then-library to library-then-executable. | Windows only. |
| `gn/is_clang.py` | Split the selected compiler command into argv before `--version`. | Only a multiword compiler command, used by the script's Zig/musl branches. |
| `BUILD.gn` | Attempt to remove the exact `skia_c_api_example` block named by the script. | The supplied original BUILD.gn has no such block; that replacement is a no-op here. |

The script restores its original files on its normal `beforeExit` path.
Keep a separate record of the effective working source and any changes of
your own. Do not describe a restored pristine file or the script's no-op as
an effective source patch. The recorded crash workaround is a GN selection:
PDF HarfBuzz subsetting is disabled for native Windows x64 and the listed
musl targets, while the normal Linux glibc x64 and macOS arm64 paths retain
it. Preserve that platform distinction when comparing a replacement.

## Build the actual static boundary

The original script enables raster Canvas, PDF, SVG, Skottie, SkParagraph,
SkShaper, HarfBuzz, ICU, Expat, FreeType/WOFF2 and the named image codecs; it
disables Ganesh/GL, fontconfig/X11, PartitionAlloc and Skia's AVIF path. The
Canvas Rust source separately selects libavif/libaom through its own Cargo
dependencies. The selected Cargo source materials are under `../cargo`;
one AVIF implementation's source/version must not identify the other.

The script explicitly uses in-tree dependencies for Expat, FreeType,
HarfBuzz, ICU, JPEG, PNG, WebP and zlib. The held GN sources also show Brotli
for FreeType WOFF2 and JPEG XL, and Highway for JPEG XL. Effective defaults
and other source/configuration branches still require assessment for the
chosen target. These observations describe the retained build specification;
they are not a recovered external Skia asset-producer link map.

Once the selected external sources and tools are present, the original
Canvas source provides these build entry points in an owned working tree:

- Linux x64 glibc: `node scripts/build-skia.js` on that target's build host.
- Windows x64 MSVC: `node scripts/build-skia.js` on that target's build host.
- macOS arm64: `node scripts/build-skia.js --target=aarch64-apple-darwin`.

Set `SKIP_SYNC_SK_DEPS=0` when the dependencies have been explicitly populated
and their retained identities should be used. Otherwise the original script
runs its dependency synchronizer. The script invokes GN and then Ninja in
`skia/out/Static`; its actual flags and source transformations remain the
authority for that invocation. Select a compatible toolchain explicitly if
the producer's recorded `rust-toolchain.toml` request is unavailable.

`scripts/release-skia-binary.mjs` names ten static archives: `skia`,
`skparagraph`, `skshaper`, `svg`, `skunicode_core`, `skunicode_icu`, `skottie`,
`skresources`, `sksg` and `jsonreader`. Windows additionally supplies
`icudtl.dat`. `build.rs` builds `skiac` and adds the actual Skia library
search directory; `src/sk.rs` supplies the platform-specific static link
attributes, including whole-archive behavior where selected. Replacing an
embedded constituent requires rebuilding the affected static aggregate and
then relinking the Canvas Rust/C++ native binding. Merely placing a new
`libskia.a` next to the installed Node module does not replace its embedded
code.

Use the supplied Cargo manifest/lock, source and build inputs for the binding,
with `SKIA_DIR` pointing to the working Skia source and `SKIA_LIB_DIR` to its
`out/Static` directory. The original package's `build` script uses the NAPI
CLI with `binaryName: skia`; an equivalent compatible Cargo/NAPI invocation
must retain that Node-API interface and the target-specific static/runtime
link settings. Preserve the selected allocator and AVIF dependency sources
and their notices with the modified binding.

## Install an independently modified copy

Prepare the official delivery first, then work in a separate runtime copy.
The actual installed platform member is:

| Platform | Canvas native member |
| --- | --- |
| Linux x64 glibc | `node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node` |
| Windows x64 MSVC | `node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node` |
| macOS arm64 | `node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` |

Replace the matching member with the relinked compatible binding in the
owned runtime copy. Retain the Windows ICU data required by the chosen
binding alongside the platform package, and keep all applicable source
notices. Running the official `prepare.js` again recreates and verifies the
vendor installation; it is not a modified-binding installer. The ordinary
application startup in `src` has no release-manifest binary-byte check.

Verify the modified binding with actual Canvas image/text/native consumers
and the application's image workflows. Keep its own source changes,
selected dependencies and validation results distinct from this delivery's
vendor evidence. This source acquisition has not compiled, relinked or run a
modified Canvas binding. It establishes the complete Skia own-source access
and the concrete source/link/replacement boundaries, while remaining
applicable external source/notices and final aggregate arrangements require
their own evidence. It supplies no licensing compatibility conclusion.
