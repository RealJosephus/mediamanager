# Current WebVTT style text consumers

Eight neutral WebVTT sources request explicit ASS and SSA output through the
shared current subtitle scenario. The cases cover one class around a whole cue,
a partial run, adjacent classes, nested classes and reset declarations, font and
alpha colors, text shadow, a standard shadow declaration and font size. Each
output has full, cropped and timestamp-preserving windows: 48 conversions.
No source embeds an expected conversion, detector label or internal style state.

The designated public `ISubtitleEncoder.GetSubtitles` supplies all expected
responses and errors twice in the same Actions run. Node uses its formal Local
storage and PostgreSQL HTTP runtime. Complete generated files, actual Native
reads of those files, Node reads of the actual Native writer files, warm/cold
rows, same-format originals, source hashes, real client cancellation and complete
resource cleanup use the existing scenario. Generated layout retains the
existing exact line comparison apart from accepted line endings. Original
response bytes and stored source bytes remain exact.

The reviewed public conversion path is the designated WebVTT reader and ASS
writer. The reader retains the STYLE header, and the ASS writer consumes it via
`WebVttToAssa`. SSA is an independent output control because its writer does not
have that WebVTT style conversion branch. The comparison consumes the complete
output style declarations, event fields and visible cue text. It does not assert
a particular private style name, object identity, paragraph layout or property
count, and it does not require subtitle rendering or burn.

The dependency review uses libse 4.0.12, LGPL-3.0, whose NuGet metadata identifies
SubtitleEdit commit `6305d8ff4df1c7e7b55cf6d647ac6c95464071b1`:
[WebVTT style reader](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/Common/WebVttHelper.cs),
[ASS conversion](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/Common/WebVttToAssa.cs).
The two-token `text-shadow: #101010 3px` input is the shape handled by the actual
`SetTextShadow` reader at lines 272–292. The standard multi-offset shadow form
and font-size declaration are controls; their behavior is observed rather than
asserted from CSS standards or source predictions.

These source links document the review. Execution depends on the declared
same-run assemblies and sealed Native source offer, not new downloads or a local
NuGet cache. The Native fixture uses an isolated real HTTP text-input host and
public error middleware, without claiming a full MVC host or Native file input.
No audiovisual generation, encoding, OCR, subtitle rendering or local test
execution is involved. Component results do not establish full or release
acceptance.
