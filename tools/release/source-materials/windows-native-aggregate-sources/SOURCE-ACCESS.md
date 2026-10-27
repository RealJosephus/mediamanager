# Windows Sharp/libvips native source inputs

`catalog.json` now supplies the complete original native container set selected
by actual current GNU Make capture
[40520403482](https://github.com/RealJosephus/mediamanager/actions/runs/40520403482):
29 native nodes, 28 original containers and 16 original source patches for the
static-dependency Windows x64 Sharp variant. Twenty containers are reused by
exact SHA-256 from the existing native/POSIX groups. Eight additionally supplied
Windows containers contain 39,651,511 compressed bytes. The complete containers
also preserve 116 separately readable original notice/permission files,
including FreeType's original FTL/GPLv2 texts and mozjpeg's original IJG text.

| Additional Windows input | Original compressed bytes |
| --- | ---: |
| AOM 3.14.1 | 6,368,868 |
| Fontconfig 2.18.3 release | 1,172,016 |
| FreeType 2.14.3 release | 2,670,220 |
| HarfBuzz 14.3.1 release | 19,826,476 |
| Highway 1.4.0 release | 3,691,557 |
| libpng 1.6.58 release | 1,070,096 |
| mozjpeg `0826579` tarball | 2,442,626 |
| TIFF 4.7.2 release | 2,409,652 |

These are the original containers whose hashes the actual expanded MXE recipes
select. Release archives, GitHub archive exports and GitHub tarball exports can
have different original compressed bytes at the same version. The additional
Windows containers do not replace the separate original POSIX acquisitions.
FreeType and its bootstrap package share one original container.

The complete producer repository at
`libvips/build-win64-mxe` `09cfccf20b91b441fbe97fa7a7ed8a597e55e830`
and current compatible MXE base at
`kleisauke/mxe` `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`
are supplied as original, unmodified GitHub source containers. Their total
compressed size is 2,710,152 bytes. `build-inputs.json` retains their original
URLs, HTTP receipts, commit/recursive-tree responses, complete archive member
catalogs and the original MXE notice. Source headers and patches remain in the
complete containers. The current base commit is a newly observed snapshot of
the branch named by the original `container/base.Dockerfile`,
`llvm-mingw-20260605`; it is not attributed to the historical binary producer.

## Actual input variant and runtime boundary

The original Sharp/libvips `build/win.sh` selects
`vips-dev-x64-web-8.18.6-static.zip`. The relevant MXE target is
`x86_64-w64-mingw32.static`, with `vips-web`, mozjpeg, zlib-ng, web dependencies
and proxy-libintl. The original default build script can build other targets;
those defaults do not describe this specific Sharp input.

The libvips recipe forces libvips itself to `--default-library=shared` even
when dependencies use that `.static` target. The resulting outer runtime
boundary includes `libvips-42.dll`. The original Sharp packaging script removes
`bin/libvips-cpp-42.dll` and copies the remaining DLLs into its `lib` directory.
Consequently an outer DLL does not establish use of the `.shared` MXE
dependency variant, and the removed C++ DLL is not a mandatory installed Sharp
replacement boundary. Rebuilding an embedded constituent requires rebuilding
the compatible outer DLL and, where its interface requires it, the Sharp
binding from the exact supplied npm source.

## Current effective source graph capture

`windows-native-source-graph.yml` validates the complete original source
containers and runs the GNU Make metadata capture on a Linux build host. It
does not compile a native package or recover a historical builder image.

The capture extracts the verified containers into an owned source working
directory, installs the producer's unchanged release settings, and supplies
the original plugin sequence: LLVM/MinGW, producer `build`, mozjpeg, zlib-ng,
web dependencies and proxy-libintl. An additional Makefile writes metadata
using the original Makefile's actual rule lookup, normal dependency,
order-only dependency and source dependency functions. The explicit capture
target has no package-build prerequisites. Both complete edge output and a
second observation of the selected source metadata are retained with the
actual commands, stdout and stderr.

Traversal starts at the exact `.static` `vips-web` target. Build-host packages
and the declared `cc`, `meson-wrapper` and Rust tool boundaries are retained as
such; they do not silently exclude native libraries. Available compatible
build tools remain prerequisites. Their presence does not require old compiler
binaries, full historical package-manager reconstruction or byte-identical
binary output. The graph requires every selected native package version to
agree with the actual held Windows constituent declaration, including AOM
3.14.1 rather than the POSIX 3.15.0 or Canvas 3.11.0 input. It retains original
selected patch files and their source-container associations.

An incomplete or inconsistent graph, missing source input, disabled selected
rule, changed observation or failed command remains failure. The final receipt
starts with `completed: false` and becomes true only after complete capture
and removal of its owned working directory. This producer-input stage alone
does not claim that the selected native source closure has already been
acquired or that a modified DLL has been built or run.

The consumer independently reads the complete 59,210-byte original Actions ZIP,
checks its original API SHA-256
`e5f37164586e2560728eb8054ff83694f2b4d767828885e32acf6e0cfe8f203b`,
every original member's CRC/SHA, the completed run/job, original producer Git
blobs/trees and exact build-input catalog. It reconstructs selection from the
original complete edge table and checks the selected source table, required
containers and selected patches. It then streams every regular file from all
28 supplied original native containers and checks their complete member and
notice inventories. Current Windows constituent version declarations remain
bound by value; an old artifact is not evidence for a changed dependency.

## Source reuse and recombination work

Use the actual captured checksums and source identities to associate selected
Windows inputs with the existing complete POSIX/native/Rust source groups.
Equal version strings alone do not identify the same archive: release
containers and Git exports may differ while retaining their respective
original source meanings. Keep new Windows-only or differently packaged
original inputs separate, and retain all selected source patches and inline
edits. Do not substitute Skia's native sources or the POSIX AOM version.

For a current build, preserve these original containers and create a separate
working copy. Populate a private source cache with the actual selected source
containers and use the captured plugin sequence, original release settings,
patches and `.static` dependency target. The original producer's
`build.sh --without-prebuilt --target x86_64-w64-mingw32.static vips-web`
describes a source/bootstrap route. Its base Dockerfile's floating branch
checkout must be adapted in that working copy to the supplied current base
source or its exact newly recorded commit, preserving that current adaptation
separately. A supported compatible toolchain may be used instead of recovering
the unknown historical prebuilt image. Required native source/cache and Rust
workspace inputs must be present before claiming an offline aggregate build.

`windows-native-source-preparation.yml` runs a separate current source
preparation in CI. It supplies all exact containers in an owned MXE cache,
copies the original release settings and plugin order, and invokes the
original GNU Make `prepare-pkg-source-<package>` targets for all 29 selected
native nodes. Those targets unpack the complete original containers and apply
their selected fixed patches. The evidence preserves original command output,
complete resulting per-package member inventories and actual changed source
files; it requires all 16 selected patches and successful owner cleanup before
marking preparation complete. It does not execute native package build targets.

Build-time inline source/configuration edits still belong to the actual
`*_BUILD` rules in the complete original producer. They include generated
HarfBuzz configuration changes, Pango's utility removal, libvips' selected
static-constituent/shared-DLL build, and the applicable Meson/CMake flags. The
original rules retain those exact edits and perform them in their original
order when the modified compatible native prefix is actually built. A source
preparation receipt does not assert that these build-time changes, compilation
or DLL loading have already occurred.

Apply the actual selected source changes, build the modified constituent and
dependent aggregate into a private prefix, and install compatible
`libvips-42.dll`/binding members into an owned runtime copy after ordinary
delivery preparation. Exercise real Sharp/native image consumers and
application image operations. The official `prepare.js` recreates vendor
bytes when run again; ordinary application startup does not enforce a
release-manifest binary-byte comparison. No successful modified native
compile, relink, replacement or licensing compatibility conclusion is claimed
by this initial source graph producer.

The native container/notice supply is complete for this named current graph.
The separately held Windows librsvg current Rust graph and source group supply
its 160 registry inputs and exact effective source/lock. Neither Cargo cache
hits nor absence of a `Compiling` line exclude a selected source. Other MXE
architectures, debug/all-deps/HEVC variants and unselected package sources are
outside this profile. Historical builder/compiler recovery, binary equality
and an actual modified aggregate's functional validation retain distinct
meanings. Ordinary offline installation of the Node delivery gains no Make,
Rust, archive-tool or native-compiler prerequisite.
