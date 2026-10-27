# Original source and build materials

`source-offer.json` binds the original public Sharp/libvips job responses and
compressed original logs, their `recipe-fragments.json`, and the
`native-packages.json` catalog. Release packaging checks the catalog references
against the actual delivered bytes. Each group identifies its selected source
scope and applicable notices. Source acquisition alone does not establish
consumer execution or final release acceptance.

## Current selected source and executable build index

| Scope | Complete source inputs and instructions |
| --- | --- |
| Sharp POSIX native selection | [Additional original native sources](native-aggregate-sources/SOURCE-ACCESS.md), together with the eight-library group and selected GVDB fallback below |
| Sharp Windows x64 static-dependency selection | [Original native containers, current MXE graph and source preparation](windows-native-aggregate-sources/SOURCE-ACCESS.md); the forced shared libvips outer DLL does not change the actual `.static` dependency selection |
| librsvg current Linux x64/macOS arm64 Cargo selection | [Actual post-edit source, effective locks and complete selected registry containers](rsvg-posix-sources/SOURCE-ACCESS.md) |
| librsvg current Windows x64 Cargo selection | [Actual patched source, effective lock and complete selected registry containers](rsvg-windows-sources/SOURCE-ACCESS.md) |
| Canvas current Linux x64/Windows x64/macOS arm64 Cargo selection | [Actual default normal/build graphs and supplied container associations](canvas-current-graphs/SOURCE-ACCESS.md) |
| Canvas Skia native selection | [Complete own source](skia-sources/SOURCE-ACCESS.md) and [selected original dependencies](skia-dependency-sources/SOURCE-ACCESS.md) |
| Executable Linux libvips modification and real image consumers | [Private-prefix build, runtime replacement and Sharp/application PNG/JPEG/WebP steps](../native-recombination-linux/README.md) |

Each group preserves its original containers, source changes, selected profile
and notices. Current effective Cargo locks are supplied separately from the
pristine source locks and are not presented as recovered historical locks.
The executable Linux arrangement uses current compatible system prerequisites
and does not describe a full-codec or three-platform aggregate rebuild. Source
possession, preparation, compilation and actual consumer execution remain
distinct evidence; this index records where their inputs and steps are held.

## Complete selected native source containers

[Source access and modification instructions](native-full-sources/SOURCE-ACCESS.md)
accompany eight complete original published source archives for FriBidi, GLib,
libexif, libheif, librsvg, libvips, Pango and Cairo. Their 77,070,535 compressed
bytes are supplied unchanged; all original directory, permission, ownership,
timestamp and symlink metadata remain in the archives and acquired member
catalogs. Seven source checksums match the held MXE recipes; Cairo matches its
original official checksum response. The complete proxy-libintl source is
supplied separately as described below.

`native-full-sources.json` binds each source/version/URL, archive, member catalog,
original notices, actual recipe source region and named patches. Assembly reads
current installed component declarations, checks whole-archive identities, lists
actual members, and streams regular file contents through the existing `tar`
tool. It selects regular files explicitly so original link/directory stdout
behavior cannot change file boundaries. Full-archive hashes preserve the
original metadata; the separately acquired catalogs record that metadata.
This reader is an assembly tool and adds no `tar` prerequisite to the user's
`prepare.js` runtime installation path. It executes no supplied source.

Pristine archives, original producer patches and in-place edits are kept
distinct. The instructions describe source access, selecting platform changes,
and building/replacing the actual aggregate library boundary, with links to the
other supplied source groups and executable Linux steps above. Source-container
checks alone do not establish successful compilation, runtime replacement or
release acceptance. The separate groups retain their actual selected scope;
all Cargo/Skia entries, old compilers and byte-identical historical binaries
are not new gates.

## GLib's selected gvdb fallback

`native-fallback-sources/gvdb` supplies the complete original GNOME source
archive at `2b42fc75f09dbe1cd1057580b5782b08f2dcb400`, with all 14 original
regular files (108,451 bytes), its original `COPYING` and
`LICENSES/LGPL-2.1-or-later.txt`. The 24,716-byte original archive, original
GitLab commit/tree responses and raw Git commit object remain separately
identified by `native-full-sources.json`.

The held POSIX GLib recipe explicitly selects `--force-fallback-for=gvdb`.
Its pristine source archive's `subprojects/gvdb.wrap` names this repository
and exact commit. Assembly checks the extracted wrap against its original
GLib archive member, hashes the raw commit, reconstructs every original
Git subtree and verifies every archive file's Git blob identity. Missing
selected source or original notices cannot be hidden by repinning the local
catalog. The supplied archive is a current exact-revision acquisition; it is
not a recovered producer download or evidence of a rebuilt library.

Unpack this source into `subprojects/gvdb` of a separate GLib working source
copy when using the retained POSIX recipe; keep the pristine original and its
notices separately. GVDB's own README describes an embedded subproject without
independent ABI guarantees, so replacing an outer shared library still
requires the GLib/libvips aggregate build described in
`native-full-sources/SOURCE-ACCESS.md`. This source narrows that concrete
fallback gap without claiming the remaining aggregate source closure,
Windows selection, modified-library relinking or final release acceptance.

## Sharp constituent MIT notices

`sharp-native-notices/components` supplies three original copyright and
permission texts. Their exact release refs, annotated-tag response where
present, commit/root or subtree responses, Git blobs, sizes and SHA-256 values
are retained in `native-packages.json`. The raw texts are unmodified.

| Component | Version | Original notice | Bytes |
| --- | --- | --- | ---: |
| Expat | 2.8.3 | `libexpat/libexpat`, `R_2_8_3`, `expat/COPYING` | 1,144 |
| cgif | 0.5.3 | `dloebl/cgif`, `v0.5.3`, `LICENSE` | 1,099 |
| Little CMS | 2.19.1 | `mm2/Little-CMS`, `lcms2.19.1`, `LICENSE` | 1,080 |

The held original Sharp/libvips recipe at
`6e5971d333377743163edc3ad9e5d0b897abcbc9` declares these three versions in
`versions.properties` and names their release downloads in `build/posix.sh`.
The material reader checks that association, follows each original release ref
to the retained commit, and checks each notice against its original Git tree
and blob. The recipe supplies source identities; matching Windows version
declarations do not claim that Windows used this POSIX producer.

`sharp-native-notices/platforms` retains the actual small `versions.json`
declarations for `@img/sharp-libvips-linux-x64` 1.3.3,
`@img/sharp-libvips-darwin-arm64` 1.3.3 and `@img/sharp-win32-x64` 0.35.4. Each
declares the three component versions above. The Windows member was read from
the existing exact locked npm archive. The POSIX members were obtained from
their named, versioned npm CDN URLs; their original bytes match the installed
members in the observed delivery manifests. Those URLs and member paths remain
in the catalog. These CDN reads are current exact-version source reads, rather
than recovered historical HTTP responses.

The compressed original delivery manifests and original receipts from
[40277422998](https://github.com/RealJosephus/mediamanager/actions/runs/40277422998)
at candidate `6bba067cc59d5d499d46a828797bfa65adf7be81` record the observed
origins of those small members. Their archival integrity pins preserve that
evidence. Current assembly checks the current lock's package/version,
distribution URL/integrity and platform declarations, then reads the matching
actually installed package's `package.json` and `versions.json`. The MIT
associations use their three named component fields; the proxy/Cairo groups
below add only their own two named declarations. The
current dependency declarations and the source-offer/catalog/notice file pins
are bound into the new release manifest by the normal packaging path.

Current assembly does not compare its whole package, member hashes, runner or
binary output with that old delivery. JSON key order/formatting and unrelated
component fields are not notice-association requirements; normal delivery file
integrity remains separate. In particular, the retained Windows AOM 3.14.1 and
POSIX AOM 3.15.0 declarations are distinct from Canvas Cargo libaom 3.11.0. This
slice does not use one of those constituents to identify another.

These three notices narrow the actual applicable notice gap. They do not supply
a complete native link map, all original constituents' notices or an actual
corresponding-source arrangement for the separately declared LGPL families
(fribidi, glib, exif, heif, rsvg, vips, pango and proxy-libintl) or Cairo MPL 2.0.
Those arrangements remain separately scoped to the actual applicable terms.
The catalog does not require complete source for every MIT component, every
Cargo/Skia DEPS entry, historical toolchains or byte-identical old binaries, and
it supplies no licensing compatibility conclusion.

## Sharp selected source and Cairo terms

`sharp-native-components/proxy-libintl` contains the complete own source at
upstream tag `0.5`, commit `33934de09af6a6627eb44e310a8079df009abdbb` and root
tree `648201782867384df841d7cd735d4757e8152047`. All five original files are
supplied: `libintl.c`, `libintl.h`, `meson.build`, `README.md` and `COPYING`
(39,244 bytes). Original ref/commit/tree responses bind their Git blobs and
raw identities. The original 13,056-byte
[source archive](sharp-native-components/proxy-libintl/proxy-libintl-0.5.tar.gz)
retains its Git PAX comment, root directory and original file bytes. Its
SHA-256 `f7a1cbd7579baaf575c66f9d99fb6295e9b0684a28b095967cfda17857595303`
is also the checksum in the held Windows MXE recipe. The material reader checks
the recipe/version/archive identity and each supplied source member against
the original complete Git root. This checksum identifies a source container;
it does not require historical binary reproduction.

The source grants LGPL version 2 or later and its actual Meson recipe selects
`STUB_ONLY`. The POSIX producer builds this stub only for Darwin/musl; its
emitted version field alone does not identify a separate linked proxy library
on glibc Linux. The Windows MXE input names the same version/archive. This
complete upstream own source does not establish final reachability of every
symbol or the full aggregate's source/recombination arrangement.

`sharp-native-components/cairo` contains the original Cairo 1.18.4 `COPYING`,
`COPYING-LGPL-2.1` and `COPYING-MPL-1.1`. The original GitLab tag response,
annotated tag object `7f3ad250e06b422010635abefb5e58eb1d8af4c1`, commit object
`4541e0cd3a751b85e52e2a83d02ac6145a5efa85`, root tree
`ed11e5bef7e29b8a4b89902e9e078537b5785c7d` and original root/file API responses
bind these raw notices. The checker hashes the Git objects, the canonical
root listing and each original file blob. This identity association does not
verify a signing key or its trust.

The original Cairo `COPYING` offers LGPL 2.1 or MPL 1.1 and points to per-file
notices. It explicitly confines the library implementation to `src` and
separates auxiliary `test`, `util` and `perf` sources. The original Sharp/libvips
publisher table instead declares MPL 2.0; the same table is now also held as a
Git-verified recipe source. Both statements remain unmodified and separately
identified. `MPL-2.0.txt` is the complete original text from the
[official Mozilla plain-text link](https://www.mozilla.org/media/MPL/2.0/index.f75d2927d3c1.txt).
These four terms files total 70,590 bytes. They do not assert a license
compatibility conclusion or complete Cairo source acquisition.

The actual current platform versions additionally bind proxy-libintl 0.5 and
Cairo 1.18.4. The original POSIX recipe names
`https://cairographics.org/releases/cairo-1.18.4.tar.xz`; that is a precise source
reference, and the complete archive is not supplied in this terms slice. The
complete source archives are separately available in the group above. Held
recipes also retain real GLib patches, libvips changes, and Pango/librsvg source
edits. The complete source group above supplies access and producer-change
instructions for these selected archives. Further selected aggregate inputs and
a complete modification/recombination arrangement remain unestablished here.
The existing generic GPL 3/LGPL 3 texts remain supplied
choice materials. Copies of other generic license versions, every Cargo/DEPS
entry, old compilers and byte-identical old binaries do not become new release
requirements through this slice.

## Koffi 3.3.3

`npm/koffi/koffi-3.3.3.tgz` is the exact published main archive named by
`package-lock.json`. Its SHA-512 is checked against both the lock and original
registry response. The member catalog describes all files actually present in
that archive, including Koffi's own FFI C++ and ABI assembly, `cnoke.cjs`, the
CMake recipe, native base support, Node-API headers and node-addon-api headers.
The original npm archive is the source container; an upstream Git commit or a
separate libffi source dependency is not inferred.

The three extracted license texts retain their original archive member names
and bytes: Koffi's `LICENSE.txt`, Node-API headers' `LICENSE`, and node-addon-api's
`LICENSE.md`. The registry receipts for Linux x64, Windows x64 and macOS arm64
bind those precise optional packages to the main package declarations and their
actual lock integrities. They do not establish a complete license review of
every original native constituent or an original binary producer/toolchain
receipt.

## Canvas 1.0.9

`recipes/canvas` contains the complete own `src` and `skia-c` directories at
`b2723ffae4e74e8c9df752902b137ec4061530e9`, the exact `gitHead` in the original
main npm registry response. Commit and root/subtree responses bind each blob's
Git identity, raw SHA-256, path and size. The original source trees contain
nineteen Rust files (455,606 bytes) and the C++ implementation/header pair
(155,840 bytes), including the checked-in Rust inputs used by those modules.
The complete-directory claims are checked against the original trees.

The retained build inputs are `.gitmodules`, Cargo manifest/lock, the main
license, `build.rs`, target `.cargo/config.toml`, `rust-toolchain.toml`,
`llvm-version`, package/Yarn manifests and lock, the declared Docker recipe,
publication and Skia workflows, Rust setup action, and the named Skia download,
Skia build and C++ runtime build helpers. The Skia build helper also retains its
actual declared in-place source changes. These are original source files;
the checker does not execute them. The C++ runtime helper and Dockerfile are
repository sources at this commit, rather than records that the external asset
producer executed them. The external Yarn CLI selected by the
configuration, SDK/container contents and complete build-tool distributions are
not supplied by those manifests.

The main and three platform packages retain their original registry and npm
attestation responses. The consumer decodes their SLSA statements and compares
the subject's SHA-512 with the exact lock/registry integrity, and the declared
source commit, workflow and invocation with the archived Git and run receipts.
The original upstream publication run is
[34340650671, attempt 1](https://github.com/Brooooooklyn/canvas/actions/runs/34340650671/attempts/1).
The job receipt retains the actual Linux x64, Windows x64, macOS arm64 and
publication jobs. This association check does not independently verify DSSE
signatures, certificates, transparency proofs or trust roots; their original
bytes remain available for a separate verification.

The publication workflow collects matrix artifacts and downloads external Skia
libraries. Its provenance does not identify the original producer or establish
the historical bytes of those external assets. The download script derives a
release tag from the Skia gitlink and can replace release assets. The retained
gitlinks are identities, not acquired complete source archives. The selected
Cargo source containers described below are supplied separately; the remaining
Cargo.lock entries do not supply their source or notices through the lock alone.

The complete Skia own-source archive is supplied separately below. Complete
depot_tools and further native third-party/Cargo source archives, their
applicable original notices and the external Skia producer's actual records
remain outside this Canvas-source slice. The ten static Skia libraries and
Windows ICU data named by the source/recipe are not supplied as historical
build inputs here. No binary rebuild, identical historical output, historical
toolchain replay or license-compatibility conclusion follows from these
materials.

## Canvas selected Cargo sources

`cargo` holds five original published crate archives. Their compressed bytes
are bound to the SHA-256 in the original Canvas `Cargo.lock`, which is itself
bound to the Canvas Git source above. The exact-version registry responses,
actual archive member catalogs, original `.cargo_vcs_info.json` values and
extracted notices remain associated with each archive. The current registry
responses identify these exact published versions; they are not recovered
historical build records.

| Published crate | Exact version | Archive bytes |
| --- | --- | ---: |
| mimalloc-safe | 0.1.64 | 7,437 |
| libmimalloc-sys2 | 0.1.60 | 1,650,943 |
| libavif | 0.14.0 | 17,241 |
| libavif-sys | 0.17.0+libavif.1.0.4 | 1,293,639 |
| libaom-sys | 0.17.2+libaom.3.11.0 | 3,953,263 |

The declared source consumers are Canvas's global `mimalloc_safe::MiMalloc`
allocator and its AVIF encoder with `codec-aom` selected. The published
containers include their Rust wrapper/build inputs and the bundled native
mimalloc, libavif and libaom sources. They preserve all 1,620 files actually
published in those five archives, including the GNU long member paths in
libavif-sys. They are the published containers, with their manifests' excluded
files, rather than complete upstream repository snapshots.

Eighteen named LICENSE/PATENTS/AUTHORS members are additionally available under
each crate's `notices` directory and checked against their original archive
bytes. Their presence also covers optional, target-specific and unselected
source content; it does not declare that every directory was linked. For
example, Canvas does not select mimalloc's `v3` feature, the held libavif-sys
build input disables libyuv and libsharpyuv, and libaom-sys accepts externally
supplied static-library paths.

The libavif-sys and libaom-sys archives omit their own repository root LICENSE.
Each `repository-notice` directory supplies that original root notice at the
precise VCS base declared by its archive, with original Git commit/tree/blob
receipts. The libaom-sys archive explicitly declares `dirty: true`. Its exact
published bytes remain authoritative; the Git base notice does not represent
the whole archive as a clean checkout. The material checker preserves that
distinction and executes none of the held build inputs.

These archives narrow the actual source and notice gaps for the selected
allocator/AVIF chains. They do not supply all Cargo dependencies, complete
Skia and its selected dependencies, every original native constituent's
source/notices or the producer's external-library/toolchain environment. No
historical byte-identical rebuild or licensing compatibility conclusion is
claimed.

## Related original notices and dependency declaration

The separately supplied [complete Skia own source and modification/recombination
instructions](skia-sources/SOURCE-ACCESS.md) extend the root-notice slice below.
Its original 79,689,406-byte archive preserves all 12,396 regular Git files,
original directories and the original symbolic link. `skia-sources.json` binds
the complete recursive Git tree, ten original notice/author files and eighteen
original build/selection files to Canvas's actual Skia gitlink. Assembly streams
the original TAR members and verifies their Git identities without extracting
paths, retaining the whole decoded tree in memory or executing source. The
instructions distinguish pristine source, the actual platform-specific Canvas
changes, the ten static-library link boundary and the installed Node binding
replacement. Applicable external dependency source/notices and final aggregate
closure remain separately scoped; a complete Skia DEPS list is not itself a
claim that every entry is linked.

`related-sources/skia` retains the original root `LICENSE` and `DEPS` at Skia
commit `a9c42c9fce77cd748805df0ec67ef5718800b1e9`.
`related-sources/depot-tools` retains the original root `LICENSE` at
`8efa575d754b8703d99b0f827528e45aeaa167aa`. Each original notice is checked against
its Git commit/tree/blob and the precise Canvas Gitlink and `.gitmodules`
repository that refer to it. The depot_tools group describes build-tool source;
it does not identify a compiler executable or delivered runtime binary.

These original root notices and Skia's dependency declarations narrow the
documented material gaps. They do not supply the complete linked native source
or every component's applicable original notice. Skia DEPS and Cargo.lock also
contain build, development and target-specific entries; their mere presence is
not a claim that every entry is linked into the three delivered native bindings.
Historical SDK, job-log or byte-for-byte rebuild evidence is a separate matter
and does not become a new release gate through this catalog.

## Selected Skia native dependency sources

[Dependency source access and recombination](skia-dependency-sources/SOURCE-ACCESS.md)
accompany twelve complete original Gitiles containers at the actual root Skia
DEPS revisions. Their 148,014,420 compressed bytes preserve 14,617 regular files,
thirteen symbolic links, directory entries and original nested gitlinks. Forty
original notice/author/patent files are also separately readable. Raw original
Git commit objects and generated complete Git/member catalogs bind every source
file and retained link to the declared repository/revision. The streaming reader
handles the original PAX path/time records without materializing the full trees
or extracting archive paths.

The group covers the in-tree codec/text sources selected by the held Canvas GN
configuration, including PNG/zlib defaults and the Brotli/Highway dependencies
of JPEG XL and FreeType WOFF2. The reader checks actual configuration/source
associations. It does not present the whole DEPS list, standalone nested build
graphs, tests or historical toolchains as mandatory constituents. Pristine
sources, producer source changes and the actual static-library/native-binding
relink boundary remain distinct. This completes access to these named own-source
containers; other applicable Rust/native inputs, successful modified aggregate
validation and final release acceptance retain their separate scope.

## Canvas Rust source observations and declared Windows dependency

[Original compile observations and Rust source access](canvas-cargo-sources/SOURCE-ACCESS.md)
retain the three original publication job logs and job responses associated
with the actual Canvas commit. Their successful library build windows contain
83 distinct registry versions. Cache-hit evidence remains in the complete raw
logs; absent compilation rows are not treated as proof of absent dependencies.
The actual libloading Windows manifest additionally selects windows-link 0.2.1,
which is supplied separately without inventing a compile row.

The group reuses 31 exact held containers and supplies 53 more original published
containers (3,815,478 bytes), with all 5,090 regular published members and 145
named original notice records. Seven napi/simd containers omit named license
files; three original repository-base notice groups supply the exact root MIT
notices and commit/tree/blob responses at their published VCS identities.
Pristine published containers, original VCS declarations, repository notices
and the actual static aggregate/native binding recombination scope remain
distinct. The reader verifies observed selection, original lock/checksums,
published members and notices. It does not require every unobserved lock entry,
historical compiler/runner replay or identical vendor binary output, and does
not certify the complete historical cache/link map or release acceptance.

## Current declared Windows librsvg effective source and selected Rust inputs

[Windows source preparation and recombination](rsvg-windows-sources/SOURCE-ACCESS.md)
retain the actual successful source-graph run 40494613656: completed run/job
responses, producer bytes with compact original Git tree objects, full command
output, actual inputs and pristine/effective five-file source. The original
Windows patch and derived 83,750-byte effective Cargo.lock are held separately
from the pristine source and any unrecovered historical post-edit lock.
Assembly independently applies that original patch to private pristine copies
and checks the actual effective bytes without invoking a Rust build.

The declared default gnullvm library graph contains two local packages and 160
registry versions. It reuses 155 original librsvg containers and the exact
Canvas windows-link container, and supplies four additional original containers
(3,762,877 bytes) with complete published members, exact checksums and notices.
The current derivation, historical compiler/link scope, optional features and
full native aggregate remain distinct. It introduces no Rust requirement into
ordinary offline preparation and no historical compiler or binary replay gate.

## Additional original Rust notices and source declarations

[Original notices and declaration scope](rsvg-original-notices/SOURCE-ACCESS.md)
associate the original mutants root MIT notice with its exact published VCS
base, and sixteen original selectors MPL source-header files with the separately
supplied original Mozilla MPL 2.0 text. Complete original Git tree responses and
published member Git blobs retain those actual source associations. Unrelated
Stylo subtree licenses are not attributed to selectors.

The four older SSheldon containers have no published VCS metadata or named
original notice. Their exact version tags/complete trees and matching source
blobs are retained as that narrower association. The actual published malloc_buf
manifest's additional exclude declaration remains distinct from its original tag
manifest. No missing original permission text or copyright year is invented;
these source facts alone do not determine final legal sufficiency or link
reachability. All original containers and historical provenance remain unchanged.

## Current Canvas default normal/build source coverage

[Three actual current host/target graphs](canvas-current-graphs/SOURCE-ACCESS.md)
supply all three original small artifact ZIPs from run 40502027602, their original
API SHA-256 digests and complete capture members. Original producer Git objects,
raw stdout/stderr, unchanged source lock, actual tool identities and all source
inputs remain bound to the real run/candidate. Two original input catalogs are
separate snapshots; their historical JSON representation is not imposed on an
equivalent current source catalog.

Each actual Linux x64 glibc, Windows x64 MSVC and macOS arm64 default normal/build
graph selects one local Canvas package and 83 registry versions. Their union is
exactly the 84 already supplied containers with matching original lock checksums;
there is no additional selected Rust source gap in these named current profiles.
Historical compilation/cache/link evidence and optional/native configurations
retain their separate scope. Assembly reads the preserved artifacts without
Cargo execution, and ordinary offline preparation gains no Rust prerequisite.
