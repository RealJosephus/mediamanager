# Current Canvas default-profile source coverage

This group supplies the complete original small Actions ZIPs and every original
member from [run 40502027602](https://github.com/RealJosephus/mediamanager/actions/runs/40502027602)
at candidate `bd8f848c074f2ad5838b86a1d5d1ad9d80ef9d77`. Original run, jobs and
artifact-list responses, compressed ZIP digests, member CRC/SHA values, capture
receipts, complete stdout/stderr, and original unchanged Cargo.lock remain
separately inspectable. Each held ZIP matches its original API SHA-256 digest.

| Actual host | Target | Job | Raw tree rows | Unique packages |
| --- | --- | ---: | ---: | ---: |
| Linux x64, ubuntu-24.04 | x86_64-unknown-linux-gnu | 122181818285 | 147 | 84 |
| Windows x64, windows-2025 | x86_64-pc-windows-msvc | 122181818287 | 145 | 84 |
| macOS arm64, macos-15 | aarch64-apple-darwin | 122181818299 | 147 | 84 |

Each result selects the one local Canvas package and 83 registry versions.
Linux/macOS select cfg-if; Windows selects windows-link instead. Their registry
union is exactly the 84 containers already supplied in
`../canvas-cargo-sources.json`, with no additional missing selected source.
This positive coverage statement follows the actual three current Cargo graphs,
not an assumption from absent historical compile rows or cache contents.

The producer ran `cargo +stable tree --locked --target <actual-target> --package
canvas --edges normal,build --prefix none --format '{p} | {f}' --color never`
with the original default features and a matching actual compiler host. The
recorded Cargo/Rust version was 1.99.1. The 21,730-byte original lock retains
SHA-256 `a4cb753b26f4b1b173d6b9f3e41771075d54e5986c5110f69ca83d07d05df80a`
on all three hosts. No build script, native/image/media generator or binary
compilation was invoked.

Original producer Git blobs and compact raw tree objects bind the workflow and
source reader to the actual candidate tree. The two original input catalogs are
kept as raw producer-input snapshots; their recorded serialization is not
imposed on a later equivalent current catalog. Other original source/container
inputs are referenced by their actual bytes. Assembly checks each complete ZIP,
every member, captured input, unchanged lock, raw selected version/checksum,
actual host/target, and the selected containers supplied by the current offer.
It does not execute Cargo or require Rust for ordinary offline preparation.

The nine original lock entries for bumpalo, hermit-abi, js-sys, once_cell,
rustversion and the wasm-bindgen family are not selected by any of these actual
default normal/build graphs. Their mere lock presence does not make them source
requirements for these profiles. Optional features, development/tests, other
targets, build-script downloads, native Skia constituents and final binary
symbol reachability retain their own scope.

The original publication compile logs remain unchanged in
`../canvas-cargo-sources`. These current results are not a recovered historical
Cargo cache/fingerprint/link map, historical compiler/SDK/runner replay,
byte-identical vendor binary requirement, successful modified Skia/Canvas
aggregate build, licensing compatibility conclusion or final release acceptance.
For actual source access, modification and native-binding recombination use
`../canvas-cargo-sources/SOURCE-ACCESS.md`, `../skia-sources/SOURCE-ACCESS.md`
and `../skia-dependency-sources/SOURCE-ACCESS.md`, preserving original notices
and keeping your working changes separately from the pristine materials.
