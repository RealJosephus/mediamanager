# Current post-edit POSIX librsvg source graph

The standalone `native-source-graph.yml` workflow captures separate Linux x64
and macOS arm64 default `librsvg-c` normal/build dependency graphs. Each job
runs on the native platform of its original sharp-libvips recipe:
`linux-x64` / `x86_64-unknown-linux-gnu` and `darwin-arm64v8` /
`aarch64-apple-darwin`. The source version comes from that recipe's original
`versions.properties`, bound to the held complete source archive. The
Windows producer, patch and effective lock are not substituted for POSIX.
The explicit target must equal the actual Rust compiler host, with no
`RUST_TARGET` cross-compilation override. The original Linux container and
bootstrap are preserved as recipe inputs; this current source graph runs on
the declared CI runner without replaying that historical environment.

The producer preserves the complete original recipe region and extracts its
three original `sed -i'.bak'` commands. It executes those commands with Bash
and GNU sed, then executes the original `cargo update --workspace` command.
macOS explicitly supplies GNU sed; the actual sed version is retained. The
original files and lock remain in the repository. Isolated `pristine`,
`post-edit` (before lock regeneration), and `effective` files preserve every
workspace manifest, the relevant Meson files, backup files and locks. Full
source file/hash inventories before editing, after regeneration and after
`cargo tree` expose any other source mutation. Only the original three
edited members, their backups and Cargo.lock may change.

Both POSIX recipes declare the nightly Rust channel. These jobs select a
currently available nightly toolchain for this explicit current graph
profile. The receipt and raw command outputs bind the dispatched clean
candidate, original source/recipe/catalog inputs, actual host and compiler
host, Cargo/Rust/rustup versions, installed components, current tool binary
hashes and Rust SDK installer metadata. Every spawned command retains its
arguments, working directory, PID, completion status, timestamps and complete
bounded stdout/stderr. A command/output failure remains incomplete with its
actual logs. This is not a historical compiler, SDK or binary replay gate.

After the original lock regeneration, `cargo tree --locked --target TARGET
--package librsvg-c --edges normal,build --prefix none --format '{p} | {f}'`
must leave all effective source files and the lock unchanged. The receipt
lists every selected workspace or registry name/version, exact lock source
and checksum, observed feature set and raw tree rows. Each selected workspace
manifest must belong to the held complete archive. Matching original
`.crate` containers already present in the held POSIX, Windows or Canvas
catalogs are verified and referenced. Only genuinely missing selected
containers are explicitly downloaded, at their exact published name/version
and lock SHA-256, into `new-crates`. Cargo's isolated online dependency
resolution can itself access the registry; its cache is not an exclusion
test or a source-selection oracle. No package is selected or excluded by
historical `Compiling` observations or by cache absence, and no fixed package
count is imposed.

The profile requests Cargo default features with no additional `avif` or
`pixbuf` feature. The original POSIX recipe explicitly disables pixbuf and
its loader, and its inline changes remove GIF/WebP and Cairo PDF/PS features.
Meson is not executed here: optional feature selection from dependencies it
could find, other architectures, the historical compilation/link set and a
complete native aggregate remain separate evidence. Cargo also documents
that a normal/build tree is close to, and does not guarantee exact
equivalence with, a compilation graph. Current successful graph acquisition
does not establish historical binary reproducibility or release acceptance.

Run the producer only through GitHub Actions. It does not compile a library,
generate media, add runtime tool dependencies or change source-offer inputs.
The workflow uploads the small original inputs, stage snapshots, source
inventories, toolchain metadata, raw logs, receipt and any newly needed
original containers. Inspect a successful job's exact selected set and full
published source/notice members before incorporating it into the central
source offer. A failed or cancelled job cannot be called complete.

Primary command contracts:
[Cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html) and
[Cargo update](https://doc.rust-lang.org/cargo/commands/cargo-update.html).
