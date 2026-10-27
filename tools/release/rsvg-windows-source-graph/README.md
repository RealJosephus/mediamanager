# Declared Windows librsvg source graph capture

The standalone `native-source-graph.yml` workflow resolves the default
`librsvg-c` dependency graph for the actual Windows recipe's
`x86_64-pc-windows-gnullvm` target. It uses a currently available compatible
stable Cargo/Rust toolchain, the supplied original librsvg source and the
supplied original Windows patch, including its explicit Cargo.lock changes.
It preserves the pristine/effective files, complete command outputs, candidate,
input identities, effective lock and exact selected registry containers.
Existing matching published containers are referenced by their held paths;
new ones are downloaded only at their exact lock names/versions/checksums.

Run this producer only through GitHub Actions. It does not build libraries,
run media generation, restore an old compiler, replay a historical binary or
modify the repository's original source/patch/lock. Its isolated output is
retained by the workflow for independent inspection and source acquisition.
No local invocation or new Rust requirement is added to ordinary application
startup, offline installation or the strict full validation runner.

The default profile has no extra `avif` or `pixbuf` feature. The original
Windows override explicitly disables pixbuf; Meson can select optional
features from dependencies it finds, so this graph is not a recovered
historical asset-producer compilation/link map or proof that every optional
variant is covered. The official Cargo documentation also distinguishes its
`tree -e normal,build` graph from exact compilation behavior. Preserve that
scope when incorporating containers into a material offer.

The source patch must apply directly, and `cargo tree --locked` must leave
the effective lock unchanged. A failure retains the actual command output
and partial receipt; it cannot be recorded as completed source acquisition.
After a successful run, inspect the selected package set, original checksums
and full published source/notice members before adding the new containers
to the tracked source offer. Complete native aggregate source/recombination
and release acceptance still require their separately scoped evidence.

Primary command contract:
[Cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html).
