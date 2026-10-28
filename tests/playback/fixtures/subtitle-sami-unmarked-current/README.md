# Unmarked SAMI public charset consumers

This entry executes the original nineteen sources returned by
`../subtitle-sami-boundaries-current/input.js` without changing their names,
text, bytes or Unicode signatures. It requests the same 342 conversion windows
and original-format responses in a new current-candidate run. The failed
`ae9109c` observations from run `40211496238` remain attached to that candidate;
the new `subtitle-sami-unmarked-current` report does not replace them. In
particular, the original `multiple-language-classes` source still contains its
one unmarked UTF-8 `ç`, with no added BOM or text adjustment.

The designated `SubtitleEncoder.GetSubtitleStream` calls the UTF.Unknown 2.7.0
stream detector, takes its first result without the Playlist consumer's 0.5
confidence threshold, returns UTF-8/ASCII or no-result bytes unchanged, and
otherwise decodes the stream with the selected encoding before UTF-8 delivery.
Both HTTP and file detector entry points use the stream path. The production
normalizer reuses the existing JavaScript detector and Node text decoders. It
does not recreate .NET objects, prober layout, logs or confidence formatting.

The package metadata pins UTF.Unknown to
`fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5`. Its public source establishes that
[DetectFromFileAsync delegates to the stream detector](https://github.com/CharsetDetector/UTF-unknown/blob/fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5/src/CharsetDetector.cs),
[Detected takes the first detail](https://github.com/CharsetDetector/UTF-unknown/blob/fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5/src/DetectionResult.cs),
and [unsupported encodings can be null](https://github.com/CharsetDetector/UTF-unknown/blob/fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5/src/DetectionDetail.cs).
These links document static review. Actions bind the actual same-run designated
assembly, source offer and public encoder, and its delivered response supplies
the expected bytes, text, times or public error.

A second neutral SRT source begins with the detector's UTF-7 signature and
ordinary ASCII subtitle text. It supplies no expected status or body. The real
public Native encoder determines the unavailable-encoding outcome. Its reader
uses UTF-8 when the selected detail has no available encoding; the Node reader
uses the same default rather than rejecting that diagnostic representation.
Original input bytes remain unchanged, and the actual Local reader cancellation
and runtime/storage/PostgreSQL cleanup still run. Run `40219653114` retains the
original failed candidate that incorrectly rejected this source; a later
candidate must recompare the same bytes and public consumers.

The shared scenario retains all original bytes, source hashes, warm/cold HTTP
responses and rows, Native repeats and actual reverse text-reader observations.
Only those functional consumers are compared. Labels, confidence values and
candidate lists add no separate gate. TTML uses its existing proved XML-body
and reader comparison. The scenario does not establish `.sami` fallback,
discovery, complete subtitle support or full/release acceptance. Tests and builds
execute only in GitHub Actions.
