# Current external subtitle source text

Thirteen neutral UTF-8 sources exercise explicit conversion from SAMI `.smi` and
text `.sub` input through the designated public `ISubtitleEncoder.GetSubtitles`.
Each source requests SRT, WebVTT, JSON, ASS, SSA and TTML with full, cropped and
timestamp-preserving windows: 234 conversions. The original four SAMI inputs cover plain
multiple cues, line breaks and entities, inline markup and no dialogue. Four
MicroDVD inputs cover default frame timing, a frame-rate header, formatting and
line breaks, and time fields without dialogue. SubViewer 1 and 2 inputs supply
two other text grammars whose public readers register the same `.sub` extension.

The original ten sources retain their text bytes. Their first recording belongs
to candidate `8815e7062b414c78c01637766d2760cfe1701c6f` and run `40206625256`;
its failed result is not replaced by later observations. Three added SAMI inputs
use a final cue without a following synchronization marker: short text, Unicode
with entities and basic markup, and longer text with many words. The next
candidate records all thirteen sources with a new input identity. The public
Native consumer supplies the final cue's actual end time; the input does not
predict a reading-speed formula or contain an expected duration.

No expected conversion or public error is embedded in the input. In particular,
the actual public parser determines frame-rate-header handling, default frame
timing, selection between readers sharing `.sub`, and no-dialogue outcomes.
Both Native runs use the same declared current assemblies and sealed source
offer. A genuine parser failure is compared through the existing public error
middleware; the scenario does not require every source to succeed.

The existing [scenario](../../helpers/subtitle-text-scenario.js) records complete
formal Node Local/PostgreSQL HTTP responses, warm and cold rows, same-format
responses, unchanged stored input hashes, actual reader cancellation and
resource cleanup. For successful outputs, actual Native readers consume
delivered Node bytes, and Node readers consume the actual Native generated files.
TTML uses the existing
[generated-body comparison and reader](../subtitle-ttml-current/projection.js):
complete XML structure and public cue text/times are retained, while serializer
indentation and attribute order are projected as already proved by that
consumer. The other outputs retain their existing complete text comparisons.
Original-format bytes remain exact.

The Native boundary uses an isolated real HTTP text-input host and real public
encoder, parser and writer, with charset handling selected by the actual format
branch. It owns and drains the host and its clients before exit. Node uses the
formal Local/PG runtime. The shared boundary
provides an explicitly saved external Subtitle stream whose path extension
selects the reader; it does not probe these files or prove discovery, codec
classification, automatic playback negotiation, Native file-protocol delivery
or a full MVC host.

The source review uses libse 4.0.12, LGPL-3.0, whose NuGet metadata identifies
SubtitleEdit commit `6305d8ff4df1c7e7b55cf6d647ac6c95464071b1`:
[SAMI](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/Sami.cs),
[MicroDVD](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/MicroDvd.cs),
[SubViewer 1](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/SubViewer10.cs),
[SubViewer 2](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/SubViewer20.cs).
Their public `Extension` properties are `.smi` and `.sub`. The designated
`SubtitleEditParser` registers those extensions directly. These links document
the review and are not downloaded as execution inputs; Actions bind the actual
assemblies, Native source offer and the new fixture files.

SAMI `.sami` alias/fallback, `.xml`, `.ttml` and `.lrc` source paths require
separate evidence. The current boundary does not supply the media encoder,
subtitle cache path manager or filesystem needed by the Native unsupported-
extension fallback. Missing-dependency failures from those paths must not serve
as functional expected results. This fixture does not expand migration's
existing four-format subtitle access proof, clone LibSE types or object layout,
render subtitles, run OCR, burn subtitles or encode audiovisual media.

Only Actions execute this scenario. Component results do not establish full or
release acceptance.
