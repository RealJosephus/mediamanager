# Original notices and declarations for six published Rust packages

These materials extend the unchanged published source containers selected in
`../rsvg-cargo-sources.json`. They preserve original repository responses and
source bytes; they do not replace a missing original notice with an invented
copyright statement.

The `mutants` 0.0.4 published VCS declaration identifies
`sourcefrog/cargo-mutants` commit `14011d08c42a7cd368698fe28f77eb4cd0b65bf0`.
Its original root `LICENSE` supplies the MIT permission and 2021 Martin Pool
copyright notice. The original Git commit, complete recursive tree and blob
responses bind that readable notice to the published VCS base. The five
published original files, including `Cargo.toml.orig`, also match that base's
`mutants_attrs` subtree. Generated packaging files remain separately supplied
in the unchanged `.crate` container.

The `selectors` 0.40.0 source identifies `servo/stylo` commit
`67faaab3ff7aa66780ec1d0f51ca47e177b812d3`. Its own subtree has no named license
file. Sixteen original Rust source files carry the original MPL 2.0 header and
the Mozilla terms URL. These full source files are additionally readable in
`selectors-0.40.0/source-header-notices`; their bytes match the published
container and exact VCS base. The already supplied official Mozilla MPL 2.0
text is associated at the exact path in `sourceHeaderTerms`. This association
follows these actual headers and package declaration, rather than the separate
Cairo publisher statement. MIT/Apache files from unrelated Stylo subtrees are
not attributed to selectors.

Four older published containers have no VCS metadata. Their exact original
version tags and complete Git trees are supplied separately:

| Published package | Repository | Version tag | Commit |
| --- | --- | --- | --- |
| block 0.1.6 | `SSheldon/rust-block` | `0.1.6` | `47178790cfc9d4a8b092051d8b413b78bd31254a` |
| malloc_buf 0.0.6 | `SSheldon/malloc_buf` | `0.0.6` | `a7811e5f4c6f9685dd57ad9bfe34e9bf6b0ba4f9` |
| objc-foundation 0.1.1 | `SSheldon/rust-objc-foundation` | `0.1.1` | `0c157a59b7931430ed5ac7839381470b0c516d3c` |
| objc_id 0.1.1 | `SSheldon/rust-objc-id` | `0.1.1` | `6527cdf28fef2b155c67c1681f548ecfd794003c` |

Their published original source files match the listed Git blobs. Cargo's
normalized manifest is distinguished from `Cargo.toml.orig` where present.
For malloc_buf the published manifest additionally excludes `.gitignore`;
both exact manifests remain separately identified. These are version-tag and
member associations, not recovered absent VCS declarations or representations
that every published archive is a clean complete repository checkout.

The four version-tag trees themselves have no named LICENSE, COPYING,
copyright or permission file. Their actual published package manifests name
MIT and Steven Sheldon. Those original declarations remain in the exact
source containers. No copyright year, missing permission text or licensing
compatibility conclusion is fabricated here. A missing-named-file observation
does not by itself determine final link reachability or legal sufficiency.

Verify the named container and notice checksums before unpacking into an owned
directory, and keep pristine sources, source headers and original notices
separate from modifications. Follow the library/aggregate build and replacement
instructions in `../native-full-sources/SOURCE-ACCESS.md` and, for the declared
Windows default graph, `../rsvg-windows-sources/SOURCE-ACCESS.md`. No historical
compiler, identical vendor binary, successful modified aggregate build or final
release acceptance is claimed by this source/notice acquisition.
