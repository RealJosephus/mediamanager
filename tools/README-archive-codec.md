# Rebuild the Book archive codec

`build-archive-codec.mjs` executes the build; it does not install generated files
into the repository. Every invocation requires a new absolute `--build-root`.
Inputs and output artifacts receive SHA256 pins, external commands have separate
logs and result records, and the final receipt records the actual link map.
Failed invocations retain their partial output for inspection.

The source manifest pins four official release archives. Put those exact files
in `--source-root`; changed bytes are rejected before any build directory is
created. Full build extracts fresh sources, applies the tracked RAR4/RAR5 patches
and the zlib CMake output-name patch, then builds zlib, liblzma, BZip2 and
libarchive before linking the C bridge. The zlib patch separates an unused shared
target because Emscripten emits a static archive for it too.

Supply explicit absolute tool paths. `--emcc` and `--emar` accept Python entry
points or executables. Emscripten's prepared cache is read-only: use the matching
SDK's populated cache, including its sysroot and system libraries. The tool does
not silently regenerate or replace that cache. Its files are pinned before and
after the invocation. Different compiler/runtime inputs can produce different
artifact bytes even when all four package archives match.

Example full build (replace placeholders with absolute local paths):

```text
node tools/build-archive-codec.mjs --mode build --build-root <new-output>
  --source-root <verified-archives> --python <python> --emcc <emcc.py>
  --emar <emar.py> --cmake <cmake> --ninja <ninja> --git <git>
  --toolchain-file <Emscripten.cmake> --em-config <emscripten-config>
  --em-cache <prepared-cache> --jobs 4
```

Relink mode actually invokes the linker on explicitly supplied libraries. It
pins the same source archives and tracked bridge/patch inputs, copies the four
compiled libraries into its new output tree, and links there. It **does not**
claim to rebuild or reconfigure those library sources. Supply `--input-receipt`
for each producer receipt needed to explain their provenance. The archive library
must already contain both tracked RAR patches.

```text
node tools/build-archive-codec.mjs --mode relink --build-root <new-output>
  --source-root <verified-archives> --python <python> --emcc <emcc.py>
  --em-config <emscripten-config> --em-cache <prepared-cache>
  --archive-lib <patched-libarchive.a> --zlib-lib <libz.a>
  --bzip2-lib <libbz2.a> --lzma-lib <liblzma.a>
  --include-root <installed-headers> --input-receipt <producer-receipt.json>
```

Review `receipt.json`, `inputs.json`, `logs/`, `link.map` and `payload/` before
copying any artifacts to a candidate. A successful link is a build result;
native differential and real Book-provider consumer checks remain separate
acceptance evidence.
