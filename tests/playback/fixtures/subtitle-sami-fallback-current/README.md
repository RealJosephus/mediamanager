# Current external SAMI fallback

This fixture records the designated workspace implementation of
`ISubtitleEncoder.GetSubtitles`. An external `.sami` file is not an alias for the
registered `.smi` parser. Native first runs FFmpeg with `-c:s srt`, persists the
generated SRT, then uses its real SRT reader and requested subtitle writer. The
`.sami` writer is unsupported: its public failure can follow a successful cache
commit. `Program.cs` hosts the actual `ExceptionMiddleware` in Production mode;
it does not host Native controllers or claim a complete playback-server result.

The recorder supplies real `ManagedFileSystem`, `PathManager`,
`ServerConfigurationManager`, `MediaEncoder`, protocol classification,
`SubtitleEditParser`, HTTP clients and a fixture-owned 5244 input bridge. Only
media-source descriptors and the isolated bridge/control are controlled. Unused
disc/library repository operations throw if accidentally invoked. Such a harness
failure cannot establish a behavior baseline.

`input.js` exports `subtitleSamiFallbackInput()`. It preserves the original
unmarked single-ç SAMI source from the existing boundary fixture. Explicit UTF-8
BOM and UTF-16LE/BE inputs are declared separately; `.sami` and `.SAMI` paths keep
their original case. Sources are base64 bytes; actions are ordered requests or
explicit fixture filesystem edits. File and HTTP cases are separate. The HTTP
Native observation does not advertise production HTTP identity support.

The File matrix exercises a cold unsupported-writer request, warm and newly
constructed consumers, SRT/VTT/JSON, absent metadata, zero-byte cache, changed
source, missing source with a nonempty cache, missing source without metadata,
missing source without cache, real invalid-input extraction and cancellation
after a real FFmpeg HTTP read. The exact original outcomes remain in the capture;
an unknown branch is not turned into an invented successful result.

Native `PathManager` chooses `data/subtitles/<id-prefix>/<GUID-D>/<index>.srt`.
Native metadata is the literal source length, colon and UTC `DateTime.Ticks`.
Each capture creates independent input, configuration and cache roots. Every
action retains before/after source, SRT and `.meta` bytes, SHA-256 and actual source
stat. The originals retain paths, process identities, actual apphost arguments,
spawn and close observations, stdout/stderr files, HTTP reads, public responses,
errors and final persistent files. Fixture emergency cleanup is recorded and
fails the capture; it cannot conceal a domain-process leak.

The copied apphost retains the closed execution boundary of the existing packet
copy fixture. Its only added capability is the exact declared SAMI-input,
`-c:s srt`, declared Native-cache-output command. It forwards the same-run supplied
FFmpeg/ffprobe only for version, declared-input probing or that SRT text operation.
It rejects other codecs, output paths, filters, hardware, audio/video encoding,
OCR and recording. Rejected capability enumeration is recorded without forwarding.
The original copy fixture is unchanged.

The caller owns the `native-media-5244` lease around
`captureCurrentSamiFallback({ output, inputFile, signal })` and its Node consumer.
The capture does not acquire a second lease. It returns
`{ input, native, repeat, report, output }`. `inputFile` may be omitted to create
the declared neutral input. The consumer must retain its actual HTTP and
persistent results and compare the applicable File cases. It must preserve both
Native recordings and their source/tool/build provenance, including failures.

The repeat comparison uses public response bytes and persistent source/cache/meta
values. Process identities, absolute roots, CLR error representations, charset
confidence and private request counts are diagnostic. A detected encoding matters
when its real `-sub_charenc` argument is consumed by FFmpeg. Cancellation requires
an actual child-spawn receipt plus its held source read, not a dependency or
charset-detection error. Killed processes can leave an initial trace without a
normal apphost-final JSON marker; actual absence is observed independently.

An additional independent File source starts with the same declared valid BOM
bytes, builds its real SRT cache, then changes to the exact existing invalid-text
bytes. Two cold requests record the actual nonzero-exit behavior when an old
nonempty SRT already exists. Native may accept that surviving SRT and write the
changed source fingerprint; the recorder retains the real exit, cache and public
result instead of assuming that every nonzero exit is a public failure. No
previous source or case bytes are changed for this counterexample.

All compilation, checks, tests and execution of this recorder take place only in
the three-platform Actions validation environment with the designated same-run
Native runtime, source offer and fixed media tools. No local runner or build is
part of this fixture's preparation. It is a finite component observation, not
full, phase or release acceptance.
