# Additional SAMI public text boundaries

This is a separate neutral input identity. It does not replace the original ten
or thirteen source-format inputs or their recorded failures. Nineteen UTF-8 SAMI
sources propose 342 explicit public conversions: six retained output formats
with full, cropped and timestamp-preserving windows. No expected body, duration,
parser success or internal type layout is supplied.

The cases cover synchronization attribute order and spacing, a marker flag,
multiple paragraph and language classes, source and translated text, an open
font tag, comments and literal script/style content, named and numeric entities,
entities inside a font attribute, mixed-case document endings, repeated and
reverse times, markup without visible dialogue, Unicode graphemes and longer
formatted text. Script/style input is ordinary subtitle text; it is never
executed or rendered. Full public file bodies and actual cue text/times should
determine behavior instead of a formatting standard or a private parser model.

All inputs use the registered `.smi` extension. They can reuse the current real
HTTP text-input host and public `ISubtitleEncoder.GetSubtitles`, including actual
public error middleware, without invoking the unsupported-extension FFmpeg
fallback whose dependencies that text boundary does not supply. A genuine
content-parser error remains an observed result. TTML output must reuse the
existing generated XML and writer-body reader callbacks.

The source review is libse 4.0.12, LGPL-3.0, pinned by its package metadata to
SubtitleEdit commit `6305d8ff4df1c7e7b55cf6d647ac6c95464071b1`:
[SAMI public reader](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/Sami.cs).
The complete `LoadSubtitle` path is at lines 233–507. Its literal marker scan,
paragraph text processing and final-cue duration determine delivered text.
Actual execution must bind the same-run assemblies
and sealed Native source offer, rather than this source link or a local cache.

The original `input.js` bytes were executed in candidate `ae9109c`, run
`40211496238`. All three original jobs failed. Their unmarked UTF-8 source with
one `ç` was decoded differently by actual Native and Node, including the
same-format response. This encoding ambiguity remains an unresolved boundary;
neither the original input nor those failed observations is replaced.

The thin test entry now uses the independent `utf8-bom.js` constructor. It
imports the unchanged original sources, prepends a UTF-8 BOM to every source,
and prefixes every source/conversion name with `utf8-bom-`. Its report identity
is `subtitle-sami-utf8-boundaries-current`. The nineteen source grammars and
342 conversion windows stay the same; only the explicit encoding identity
changes. Expected files and errors still come from actual same-run Native.
This input covers only the executed, explicitly marked UTF-8 syntax
boundary. It has no accepted result before its own Actions observations.

The shared scenario does not certify complete SAMI support, normal directory
discovery, codec negotiation, migration access, subtitle rendering or release
readiness. Local test, syntax, build and media execution are not part of its
preparation.
