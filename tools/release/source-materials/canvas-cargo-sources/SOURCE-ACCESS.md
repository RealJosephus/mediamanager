# Canvas Rust sources observed in the original publication jobs

The complete original logs of the three bound Canvas publication build jobs
are supplied as local gzip containers without changing their decoded bytes.
The original job responses identify run `34340650671`, source
`b2723ffae4e74e8c9df752902b137ec4061530e9` and the actual Linux x64 glibc,
Windows x64 MSVC and macOS arm64 jobs already associated with the published
packages. The catalog retains the original ANSI/color bytes and complete
lines. Its reader parses Cargo's package rows only within the successful
`Build`/`Build in docker` time windows from the actual job responses.

The observed windows have 44, 43 and 84 compile rows respectively, including
the local Canvas package. Their union contains 83 registry name/version pairs.
The logs also explicitly show Cargo cache hits. An absent `Compiling` line
does not prove an absent dependency or a complete historical compile/link
graph. The logs and original observations are preserved without inventing
missing rows or requiring a historical compiler/runner replay.

`windows-link` 0.2.1 is additionally supplied from the exact original Canvas
lock. The actually observed `libloading` 0.9.0 source declares it as a
non-optional `cfg(windows)` dependency, and the observed `napi-sys` source
unconditionally depends on libloading. This is a separately identified source
declaration, not another recovered compilation row. The other unobserved
WASM/Hermit-related lock entries are not made mandatory source inputs through
their presence in the lock alone.

## Original published sources and notices

The offer contains or references 84 exact published registry containers.
Thirty-one matching containers were already supplied in the original selected
Canvas or librsvg source groups and are reused by path/size/SHA-256/URL.
Fifty-three newly acquired original `.crate` containers total 3,815,478 bytes.
Every container is checked against the actual original Canvas `Cargo.lock`,
its complete regular published members, package and available VCS declarations.
New acquisitions additionally retain their exact-version registry responses.
Original container bytes have not been repacked.

All 5,090 regular published source members remain available. The catalog
binds 145 named original notice/author/patent members, reusing existing texts
where held and providing 78 additional readable originals. Per-file source
headers and other original content remain in the complete containers. A
published container includes its actual exclusions; it is not represented
as a complete upstream repository checkout.

Seven newly acquired napi/simd crates have no named original license file in
their published container. Three separately supplied original GitHub notice
groups preserve the actual repository root MIT notices at the exact VCS bases:

| Repository | Exact published VCS base | Crates associated with that base |
| --- | --- | --- |
| `napi-rs/napi-rs` | `956e4525fea6a676ea3680b711382f167b899af9` | napi-build, napi, napi-derive-backend, napi-derive |
| `napi-rs/napi-rs` | `679eb79f5cf3c7c6b2850f4ab46092126f23dc5c` | napi-sys |
| `Nugine/simd` | `d74c030d9dc4f3cae02146d1f497ff62726ef09a` | vsimd, base64-simd |

Their original commit/tree/blob responses and raw notice bytes are bound to
the actual published manifest repository and VCS declarations. Original
dirty/other VCS fields remain unchanged. The repository-base notice is not a
claim that a published archive is a clean whole repository snapshot. Existing
Canvas selected native-wrapper notices retain their original separate source
associations. An SPDX expression alone is not substituted for an original
notice.

## Read, modify and recombine

Verify the compressed checksum before unpacking a `.crate` into an empty
directory you own. Keep the original container and pristine contents separate
from changes. Retain each original notice, source header and published VCS
declaration. A reused archive remains at the exact path recorded by its source
record; it is not identified merely by a matching library name.

Use Canvas's original own Rust/C++ source, manifest and lock under
`../recipes/canvas` together with its Skia own source and selected native
dependencies described in `../skia-sources/SOURCE-ACCESS.md` and
`../skia-dependency-sources/SOURCE-ACCESS.md`. Populate Cargo's source/cache
inputs with these exact version/checksum containers when building an owned
modified tree. Select an available compatible toolchain explicitly; the
recorded rust-toolchain request and historical compile logs do not impose
an old compiler binary or byte-identical output requirement.

The selected allocator/AVIF wrapper/native chains remain separate from the
Skia codec dependencies. In particular, the Canvas Cargo libaom 3.11.0 source
does not identify Sharp's differently versioned AOM inputs. Rebuild/relink
the affected static native aggregate and Canvas Node binding as described in
the source guides, install it in a separate prepared runtime copy and verify
actual image/text/native consumers. Preserve your own changes and results
separately from original vendor evidence.

These materials supply the named observed and directly declared Windows
source inputs and their stated original notices. They do not assert a
complete historical cache/fingerprint/link map, a successful modified binding
build, every optional Cargo/Skia input, a licensing compatibility conclusion
or final release acceptance. Other applicable source/native responsibilities
retain their own scope.
