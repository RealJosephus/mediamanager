# Current post-edit POSIX librsvg source access

Run 40517996415 captured the two default `librsvg-c` normal/build source
graphs at candidate `a4c77bf0184d55916c59c194cacc5378f49a8f02` and tree
`15bc5a27089e69b00c0fca1da9395628a25ca0f2`. Linux x64 selected 157 registry
packages and two workspace packages; macOS arm64 selected 161 registry
packages and two workspace packages. Their registry union contains 162
name/version pairs. Every selected original `.crate` container is already
held in the POSIX or Windows source catalogs. No new container was downloaded
for these two captures. The `crateOrigins` table identifies the exact source
catalog for each selected name/version; those catalogs supply the complete
original package member hashes, license/VCS declarations and original notices.

Both complete original artifact ZIPs are supplied, with their original run,
job and artifact API responses. Each ZIP's complete byte length/SHA-256 must
match its artifact API digest; the complete member set, raw bytes and CRC-32
are retained and consumed. The original producer commit/tree objects and
source blobs bind the actual dispatched producer independently of the current
checkout. `inputBindings` associate every actual captured input with its
original artifact member, original producer blob or an existing complete
held material. The workflow and upstream recipe's `.github` inputs omitted
by the artifact uploader's hidden-file filter remain supplied through their
original Git/material bytes and exact capture hashes. No missing input is
reconstructed from a later edited producer.

The supplied complete librsvg 2.62.91 source and its original POSIX recipe
come from the existing `native-full-sources` and `recipe-fragments` groups.
The original POSIX commands remove GIF/WebP and Cairo PDF/PS Cargo features,
edit the Meson host condition, and run `cargo update --workspace`. The ZIPs
hold pristine, post-edit and effective source/lock snapshots and complete
source member inventories. The pristine lock SHA-256 is
`fcca33feb66f75fb02199902cee0a5072cb491020d655463dfeffffc9d626941`;
both effective locks have SHA-256
`5ea585dbbcce18a8e74e094a383c4ca2f133102464bd3c9169636a485bf362c2`.
The reader independently applies the three source text transformations and
checks every other source member remains unchanged. It consumes the actual
effective lock and raw Cargo tree; it does not regenerate a lock offline.

The actual targets are `x86_64-unknown-linux-gnu` on Ubuntu 24.04 and
`aarch64-apple-darwin` on macOS 15. Both use the original POSIX recipe's
nightly channel, resolved for this explicit current profile. Raw tool
versions, compiler host, command arguments/process outcomes/stdout/stderr,
actual SDK installer metadata and binary identities are preserved as capture
evidence. The material reader uses only Node.js and supplied bytes. It does
not invoke Cargo, rustc, sed, a historical SDK or any library/media build.
The actual compiler binaries are not required for this offline source graph
material check, and their capture identities are not a historical replay gate.

This profile requests Cargo defaults with no extra `avif` or `pixbuf` feature.
The original recipe explicitly disables pixbuf and its loader. Meson was not
executed in this graph capture, so optional dependency auto-detection, other
architectures and historical compilation/link variants remain outside its
scope. Historical `Compiling` observations and cache absence do not exclude
dependencies from this current source set. These materials do not establish
a complete native aggregate rebuild, identical historical binaries, license
compatibility or release acceptance.

To inspect or modify this source slice, start from the held complete original
archive, the original POSIX recipe region, the recorded inline edit script,
and the corresponding effective lock/tree in each ZIP. Preserve all original
license and notice members when redistributing source. Any new graph/profile
must be captured and offered independently with its own actual source inputs
and selected package set.

Primary command contracts:
[Cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html) and
[Cargo update](https://doc.rust-lang.org/cargo/commands/cargo-update.html).
