# Linux libvips modification and real image consumers

The independent `Linux modified native image consumer` Actions workflow builds
libvips **8.18.6** from its complete supplied original release container, applies
the supplied producer SONAME patch and the original Linux static-C/nodelete
inline rules, then applies `png-red-bias.patch`. That private patch is licensed
under LGPL-2.1-or-later, like its libvips target. It changes successful eight-bit,
non-interlaced RGB/RGBA PNG row decoding by adding seven to red, saturating at
255. The source container is left unchanged.

The compatible build uses the recorded Ubuntu development packages, with PNG,
JPEG and WebP explicitly enabled and other optional codecs disabled. C libvips
is linked into `prefix/lib/libvips-cpp.so.8.18.6`; external current system
dependencies remain shared prerequisites. Their actual package versions,
library bytes, copyright files and referenced common license texts are retained.
This scope does not claim a reconstruction of the original Rocky Linux builder
or the full codec set of the distributed vendor aggregate.

Run it only in GitHub Actions, using the workflow's ordinary dispatch. The script
entry is:

```text
node tools/release/native-recombination-linux/build.js .test-output/native-recombination-linux
```

It creates a new owned output directory, verifies the complete source archive and
every extracted original file, and records three separate source stages:
`pristine`, `original-recipe-applied`, and `private-modification`. The original
patch, source recipe and versions remain separately readable in `original-inputs`.
Meson commands, full stdout/stderr, configure information and build logs are
retained, including on failure. An exact source mismatch, failed compile, missing
dependency or unsuccessful consumer is a failure; there is no vendor fallback.
Complete membership comparison orders both sides by the same full path;
directory traversal order cannot move a dotted sibling into a false mismatch.
The complete original extraction regression also rejects a changed source byte.
The supplied original SONAME gist patch ends without a terminal LF. Its original
514 bytes and SHA remain unchanged. Only its separately recorded executable copy
receives one final LF, with both byte identities and the exact transformation in
`patch-execution.json`; strict GNU patch still requires zero fuzz and offset. A
complete original-source regression actually applies that copy with Git, checks
the exact SONAME source edit, and rejects a conflicting original version. The
real compiled library independently has its ELF SONAME checked before loading.

The script runs the actual delivery assembler and the delivered offline prepare
entry. In that private prepared delivery it runs a stock Node process, waits for
exit, replaces only the private aggregate file with the installed newly built
library, and runs a second new Node process. The actual Sharp binding and all
application source files are retained. No application process, writable assets
or image cache is shared between these two consumers.

Each consumer checks OS-reported loaded objects and hashes the actual loaded
aggregate and Sharp binding. Both read identical PNG/JPEG/WebP source bytes.
They use Sharp for full raw decoding and the production `ImageProcessor`,
`MetadataImageAssets`, VFS and local adapter for image dimensions, a real 3x2 PNG
resize, a persisted image and cache readback. Independent Canvas decoding checks
the application output pixels, so reusing modified Sharp to decode the output
cannot apply the red bias a second time. RGB red 17 becomes 24; RGBA red 252
becomes 255; the unchanged channels, dimensions and actual output are checked.
WebP is a lossless input. JPEG is deliberately lossy and uses an explicit
three-level colour bound around the selected uniform fixture, rather than
requiring identical decoder rounding between compatible dependency versions.

Only a completed `receipt.json` with the actual candidate, original/new loaded
library hashes, source stages, offline preparation and both successful consumer
records establishes this scoped result. Negative tests reject damaged source,
changed recipe selection, unbound extraction, a still-loaded vendor library,
reused process/cache, absent red change, wrapped saturation, stale application
pixels and unclosed owners. Source preparation alone is not compilation or a
successful replacement. This exercise does not run a complete server, validate
all image codecs or establish the full/release-pair functional acceptance.

The isolated workflow has its own 120-minute job budget, 100-minute build step
and 90-minute script deadline. It changes neither the full business validation
budget nor any per-test business deadline. The regular application start and
offline prepare commands are unchanged; the private replacement happens only
after successful preparation inside this experiment.
