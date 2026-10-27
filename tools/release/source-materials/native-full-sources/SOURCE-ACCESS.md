# Native library source access and modifications

The following **complete pristine published source containers** are supplied in
this directory. `../native-full-sources.json` identifies their original URLs,
compressed SHA-256, actual members, original modes/owners/times/link targets,
extracted original notices and producer recipe associations. Seven archive
hashes match the held Windows MXE recipes. Cairo matches its original official
`.sha256sum` response. These are current exact-version acquisitions, rather than
recovered historical HTTP responses. Original archives have not been repacked.

| Library | Supplied archive | Archive bytes |
| --- | --- | ---: |
| FriBidi 1.0.16 | [fribidi-1.0.16.tar.xz](fribidi/fribidi-1.0.16.tar.xz) | 1,098,260 |
| GLib 2.89.4 | [glib-2.89.4.tar.xz](glib/glib-2.89.4.tar.xz) | 5,830,980 |
| libexif 0.6.26 | [libexif-0.6.26.tar.xz](exif/libexif-0.6.26.tar.xz) | 1,335,488 |
| libheif 1.23.2 | [libheif-1.23.2.tar.gz](heif/libheif-1.23.2.tar.gz) | 2,111,195 |
| librsvg 2.62.91 | [librsvg-2.62.91.tar.xz](rsvg/librsvg-2.62.91.tar.xz) | 6,766,696 |
| libvips 8.18.6 | [vips-8.18.6.tar.xz](vips/vips-8.18.6.tar.xz) | 25,431,000 |
| Pango 1.58.2 | [pango-1.58.2.tar.xz](pango/pango-1.58.2.tar.xz) | 1,918,112 |
| Cairo 1.18.4 | [cairo-1.18.4.tar.xz](cairo/cairo-1.18.4.tar.xz) | 32,578,804 |

The complete proxy-libintl 0.5 source and archive are separately supplied under
`../sharp-native-components/proxy-libintl`. Its POSIX build is conditional on
Darwin/musl. A glibc Linux version field alone does not establish that it links
that stub. Library version declarations are not a final native link map.

These eight containers are one part of the selected source supply. The
[additional POSIX native inputs](../native-aggregate-sources/SOURCE-ACCESS.md)
and [Windows x64 Sharp native inputs](../windows-native-aggregate-sources/SOURCE-ACCESS.md)
retain their own exact platform selections, complete original containers and
notices. The [current POSIX librsvg graphs and effective locks](../rsvg-posix-sources/SOURCE-ACCESS.md)
and [current Windows librsvg graph and effective lock](../rsvg-windows-sources/SOURCE-ACCESS.md)
associate every selected registry package with a supplied complete container.
[Current Canvas source graphs](../canvas-current-graphs/SOURCE-ACCESS.md),
[Skia own source](../skia-sources/SOURCE-ACCESS.md) and
[selected Skia dependencies](../skia-dependency-sources/SOURCE-ACCESS.md) remain
separate source groups. Their scope follows the named actual profiles rather
than every entry in a pristine Cargo.lock or Skia DEPS file.

The archives themselves retain all original source notices, including notices
for auxiliary source that was not selected for a library build. Read each
archive's original COPYING/LICENSE files and per-file headers. In particular,
GLib's original `COPYING` is a symlink to `LICENSES/LGPL-2.1-or-later.txt`, which
is supplied as an ordinary extracted notice as well. Cairo's original dual
LGPL 2.1/MPL 1.1 grant and the publisher's MPL 2.0 statement remain separate in
`../sharp-native-components/cairo`; their presence is not a compatibility
conclusion or a claim that every auxiliary directory is linked.

## Access and prepare a source copy

1. Read the source record and verify the named archive's SHA-256 before use.
   PowerShell provides `Get-FileHash -Algorithm SHA256 -LiteralPath <archive>`;
   Unix systems provide `sha256sum` or `shasum -a 256`.
2. Create an empty directory under a work location you own. Use
   `tar -xf <archive> -C <empty-directory>`. Keep that pristine directory and
   make a separate working copy before applying producer changes. A target
   filesystem must preserve the archive's case-sensitive names and symlinks.
3. Read `modifications.posix` or `modifications.windows` for the chosen source
   record. They point to the supplied original recipe and patches; the full
   exact POSIX source region is retained in the catalog. Follow the selected
   platform, rather than applying both platform modification sets together.

## Actual supplied producer changes

The original POSIX recipe is `../recipes/sharp-libvips/build/posix.sh`, with
versions in `../recipes/sharp-libvips/versions.properties`. Its source regions
in the catalog retain the actual configure flags and in-place edits.

- GLib applies the held fixed-revision `glib-without-gregex.patch` before its
  Meson setup. Its forced `gvdb` fallback is supplied under
  `../native-fallback-sources/gvdb` at the exact commit in the pristine
  `subprojects/gvdb.wrap`. Verify the catalog's compressed SHA-256, unpack that
  original archive separately, and place its root contents in
  `subprojects/gvdb` of the working GLib source before configuring. Keep its
  original `COPYING`, per-file headers and `LICENSES` directory. The supplied
  reader binds the complete source tree and notices to the wrap's original
  Git commit; no fallback build or final symbol reachability is claimed.
- Pango removes the `utils` subdirectory stanza before configuring the library.
- librsvg removes the named GIF/WebP and Cairo PDF/PS features from the two
  actual Cargo manifests, changes the named Linux host condition, then runs
  `cargo update --workspace`. Keep its pristine Cargo.lock separate from the
  resulting effective lock. The distributed source archive contains the
  original lock. The separately supplied current POSIX and Windows groups
  above hold their actual effective locks and selected source containers;
  these current captures are not recovered historical post-edit locks.
- libvips first applies the held fixed-revision C++ SONAME patch, makes the C
  library static inside the C++ shared boundary, removes the named man/po/tools
  stanza, and applies the Linux nodelete/symbol-localisation settings. These
  edits and the generated version script are visible in its original region.
- FriBidi, libexif, libheif and Cairo retain their original source and the
  actual build options in their regions. Options disabling tests, codecs or
  documentation are build selections, rather than invented source patches.

For a referenced patch, enter the corresponding working source root and run
`git apply --check <absolute-patch-path>` followed by `git apply
<absolute-patch-path>`. Apply POSIX patches in recipe order, then the explicit
in-place edits shown in that region. Preserve the original source, applied
patches and resulting files separately. The original libvips C++ SONAME patch
has no terminal LF: retain its original 514 bytes, and append one LF only to a
separate executable copy before applying it. Record both hashes and that single
byte transformation, as the Linux workflow below does. Source acquisition and
member verification alone do not execute patches or compile libraries.

Windows uses the separately held `../recipes/libvips-win64-mxe` source. Its
`build/overrides.mk`, package `.mk` files and listed `build/patches` files define
the source checksum, selected changes and build flags. The catalog lists the
actual available family patches. The `vips-web` selection is distinct from
`all-deps` and HEVC variants; do not add unrelated variant patches or GPL tools
because they happen to exist in the producer repository. The base MXE branch
and original producer environment are not represented as historically recovered
here. The separate Windows group supplies the complete producer source and
current compatible snapshot of its named `llvm-mingw-20260605` MXE branch, with
the actual selected native graph and original source preparation rules.

## Build and replace the actual library boundary

Use the retained recipes as the build specification with an available supported
toolchain, supplying their additional selected dependencies. Build modified
libraries into a separate prefix. The POSIX recipes bundle static constituents
inside `libvips-cpp.so.8.18.6` or `libvips-cpp.8.18.6.dylib`. Sharp's Windows
`win.sh` selects the `.static` `vips-dev-x64-web-8.18.6-static.zip`,
removes `bin/libvips-cpp-42.dll`, then copies the remaining DLLs, including
`libvips-42.dll`. The libvips recipe's forced shared outer library does not
change that MXE dependency selection into a `.shared` profile or make the
removed C++ DLL a required Sharp replacement. Follow the actual copied runtime
boundary in the Windows group. An outer shared library does not make each
embedded constituent independently replaceable. Rebuilding that aggregate
must include the affected constituent and the other inputs needed to produce
the interface-compatible replacement.

The exact Sharp npm archive supplied in `dependency-cache` contains its native
binding source and `src/binding.gyp`. It describes the runtime library paths and
Windows C++ binding rebuild. If that binding also needs rebuilding, use its
supplied sources against the modified library prefix. After normal preparation,
replace the matching library/binding in a separate runtime copy, keeping the
required interface, SONAME/DLL names and loader paths. `prepare.js` recreates
and verifies the vendor installation; running it again restores vendor bytes.
The ordinary `npm start` path has no release-manifest byte check in `src`.

The [executable Linux libvips modification and consumer workflow](../../native-recombination-linux/README.md)
provides a current compatible Ubuntu build into a private prefix, using the
supplied complete libvips source and original aggregate rules. Its separate PNG
decode modification is followed by actual compilation, private runtime library
replacement, OS-loaded library identification and Sharp/application image
consumers with independently decoded output pixels. That workflow's scope is
Linux x64 and PNG/JPEG/WebP with shared current system prerequisites; it is not
the full vendor codec set or a Windows/macOS aggregate build. Its instructions
describe the executable arrangement; source acquisition or preparation alone
is not a successful consumer result.

For other selected aggregate builds, use the corresponding source groups and
verify the rebuilt runtime with real consumers. The current effective Cargo
locks and selected source containers linked above do not turn unselected
original lock entries or all Skia DEPS into mandatory inputs. Historical
compilers, old runner reconstruction and byte-identical old binary output are
not requirements introduced by this source offer. Ordinary offline preparation
does not require a native compiler, Cargo or archive tool.
