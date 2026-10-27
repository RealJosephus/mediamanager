# Current Canvas source dependency graph

The original publication logs provide 83 observed registry versions and show
Cargo cache hits; absence of another compile row cannot prove non-selection.
The source offer additionally supplies windows-link from the actual observed
libloading Windows manifest. This producer audits whether those 84 exact
containers cover the current default normal/build graph.

The standalone native-source-graph workflow runs on the actual Linux x64 glibc,
Windows x64 MSVC and macOS arm64 hosts and their matching Rust targets. It copies
the exact held original Canvas source/manifest/lock, uses an available stable
toolchain and runs `cargo tree --locked -p canvas -e normal,build` with the
original default features. Actual native host identity matters for build and
procedural-macro dependencies; a Linux-only cross-target run is not substituted
for all three host contexts.

No build script, native/image/media generator or binary build is invoked.
The producer retains original input identities, unchanged lock, raw command
output, actual tool identity and selected versions. Existing exact held sources
are checked by their actual archive identity. A missing selected source is
downloaded at its original lock checksum and retained separately for review;
the receipt distinguishes graph completion from current offer coverage.

These current source graphs can establish named default-profile input coverage
when all three actual results are reviewed. They are not a recovered historical
Cargo cache/fingerprint/link map or proof of a modified native aggregate build.
Unselected lock entries are not forced into the offer, and historical compiler
or byte-identical binary replay is not introduced as a gate. This optional CI
producer adds no Rust prerequisite to ordinary offline installation or strict
application validation.

Primary command contract:
[Cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html).

The three actual results from run 40502027602 and their complete original ZIPs,
members and source coverage are supplied separately in
`../source-materials/canvas-current-graphs/SOURCE-ACCESS.md`. Each target has 83
selected registry versions; their union exactly covers the 84 supplied original
containers. This current result retains the historical publication/cache/link
and modified-native-build boundaries above.
