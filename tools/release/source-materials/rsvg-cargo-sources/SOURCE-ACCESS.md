# Observed librsvg Rust source inputs

This directory supplies 160 original published crate archives totaling
12,492,688 compressed bytes. They contain all 6,099 files actually published in
those archives, including their original Cargo manifests and available VCS
declarations. The 268 separately readable named license, copyright, notice,
patent and author files retain their original archive paths and bytes.
`../rsvg-cargo-sources.json` identifies each exact version, original static
crates.io URL, compressed checksum, full published member list and extracted
notices.

The selected set is the union of registry packages actually observed compiling
inside the original retained Linux/macOS **librsvg library** build regions.
The full raw logs and producer job identities remain in `../source-offer.json`.
The Linux region has 157 compile rows (155 registry and two local workspace
packages); macOS has 161 (159 registry and the same two local packages). Their
registry union contains 160 distinct name/version pairs. Build dependencies and
procedural macros are included when observed; compilation does not prove final
symbol reachability. Earlier cargo-c/tool compilation in those logs is outside
this selection.

The pristine original `Cargo.lock` is copied unchanged from the separately
supplied librsvg 2.62.91 source archive. Every selected name/version and compressed
crate checksum matches that original lock. The producer first edited the source
and ran `cargo update --workspace`; its resulting effective lock was not
recovered. This material preserves the pristine lock and actual observed
versions without presenting either as a recovered post-edit lock. Unused lock
entries, the Windows Rust graph and historical compiler binaries are outside
this acquisition.

To inspect or modify a source, verify its named compressed SHA-256, then unpack
the `.crate` with a standard gzip/TAR reader into an empty directory you own.
Keep its pristine source separately from modifications. Use the original
library source and the platform producer changes described in
`../native-full-sources/SOURCE-ACCESS.md` when rebuilding the aggregate. An
interface-compatible replacement requires the additional selected native inputs
and appropriate tools. These archives are source materials, not an asserted
successful rebuild or a complete aggregate relinking arrangement.

The published `block`, `malloc_buf`, `mutants`, `objc-foundation`, `objc_id` and
`selectors` containers have no separately named license/notice file. Their
original package declarations and source headers remain unchanged in the
archives. No generic text is substituted for an absent original notice, and an
SPDX expression alone does not establish complete constituent licensing.
Applicable notices, native dependencies, final aggregate source/replacement
arrangements and release acceptance remain separately scoped. No historical
byte-identical binary rebuild is claimed or required by this acquisition.
