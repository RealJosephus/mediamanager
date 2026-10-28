# Current ASS and SSA text consumers

This fixture supplies neutral subtitle text to the designated current Native
`ISubtitleEncoder.GetSubtitles` twice. Both runs use its real external HTTP text
reader and CharsetDetector, SubtitleEdit parser, playback-window filter and output writer. A small
media-source boundary provides the isolated loopback URL; it does not replace any
subtitle parsing or conversion. The process owns its real text-input HTTP host
and clients and closes them before exit. Actual Node HTTP bodies also pass through the
same runs' Native SRT/WebVTT readers.

The text cases include ordinary and generated WebVTT with repeated ASCII spaces.
The actual Native reader supplies the comparison for that text normalization.
Header-only ASS/SSA inputs exercise the real public error middleware as well as
same-format original delivery; their outcome is not predefined in the fixture.

The Native input is HTTP so the designated fork's `LocalMediaProxy.Apply` does
not redirect fixture file paths to port 5244. Node uses the formal Local/PG
runtime. This fixture does not claim Native file-protocol delivery or a complete
MVC host; it calls the real public subtitle encoder and records actual HTTP
input bytes, response completion, host/client closure and unchanged text hashes.
An actual encoder failure is passed to the designated
`ExceptionMiddleware.Invoke` with a `DefaultHttpContext`, a real response stream
and the input host's Production environment. Its actual status, MIME and body
are compared with Node's public failure; exception types and stacks remain
diagnostic. Error bodies are not fed to subtitle readers.

The Node consumer uses PostgreSQL and the ordinary Local storage plugin. It
records full public response bytes, same-format originals, warm and cold rows,
and actual client and runtime ownership boundaries. The nonempty-format Native
Controller passes `CancellationToken.None` to the encoder. The Node consumer
therefore waits for the actual server response to close after its client
disconnects, releases the held Local input, and checks the producer's complete
source bytes/hash, settled reader close, preparation and HTTP action drain.
It then reads the same cold public route again and compares its complete response
with the response included in the Native matrix. A separate held Local read
remains unreleased by the harness while actual `runtime.close()` cancels its
owner; its actual signal, settled reader close, public response closure and full
runtime/storage/PostgreSQL closure are checked. These are separate from explicit
encoder-caller token cancellation in the HTTP subtitle fixture. Error names and
stacks remain diagnostics. Native observations supply every new expected
conversion. No local recording, media generation, subtitle burn,
OCR or AV encoding is involved.

The public execution harness is shared with current writer and charset
scenarios. Inputs may provide UTF-8 `text` or exact `base64` bytes; Native serves
those same bytes and its actual charset assembly is bound to the runtime
manifest. Original-format delivery is compared to the actual Native response,
since charset conversion can produce UTF-8 before the format fast path.
Stored input preservation is checked independently after delivery.

The old `subtitle-ass-reference.json` retains its original bytes and identity.
Its ASS/SSA headers and both full legacy inputs are reused as neutral text;
the added dialogue bodies have a separate current fixture identity. Current
source offers, runtime assembly hashes, fixture inputs, initial/repeat raw
observations and actual Node responses remain in the Actions output.

The behavior review consulted the designated dependency `libse` 4.0.12. Its
NuGet metadata identifies SubtitleEdit commit
`6305d8ff4df1c7e7b55cf6d647ac6c95464071b1` and its package license is LGPL-3.0:
[ASS reader](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/AdvancedSubStationAlpha.cs),
[SSA reader](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/SubStationAlpha.cs),
[WebVTT writer](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/WebVTT.cs).
These links document the review; execution does not download them or depend on
the local NuGet cache. Each Actions run binds its actual `libse.dll` and the
sealed Native source offer, including `Directory.Packages.props`. The production
implementation uses independent Node string operations and no LibSE object model.

A successful component comparison does not grant full or release acceptance.
