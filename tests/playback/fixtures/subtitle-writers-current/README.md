# Current subtitle output writers

The neutral inputs exercise explicit ASS and SSA conversion through the shared
[current text scenario](../../helpers/subtitle-text-scenario.js). The scenario
records the designated public `ISubtitleEncoder.GetSubtitles` twice, full public
Node HTTP responses backed by Local storage and PostgreSQL, warm and cold data,
actual Native reads of delivered bytes, Node reads of the actual Native output,
public errors and reader cancellation. Expected output always comes from the
same Actions run's actual designated Native assemblies and sealed source offer.

The cases reuse the separate current text inputs and add style tables, event
actors, margins, layers, comments, reordered columns, attachment-section text,
HTML formatting and centisecond rounding. Three playback windows distinguish
cropping from timestamp preservation. Same-format and SSA-to-ASS delivery retain
the actual original-format behavior, including its bypass of conversion filters.
The complete generated file content is compared, including headers, styles and
event fields. Reader comparisons consume public text and times; no private
SubtitleEdit object layout is an acceptance condition.

The reference uses an isolated HTTP input host and the real charset reader,
parser and output writer. Node uses its formal Local/PG runtime. Input bytes,
source bindings, initial/repeat observations, response completion and process,
client, host, storage and database cleanup remain in the Actions output. This
fixture does not claim a Native file-protocol or full MVC host.

The behavior review uses the designated dependency libse 4.0.12, LGPL-3.0,
identified by its NuGet metadata as SubtitleEdit commit
`6305d8ff4df1c7e7b55cf6d647ac6c95464071b1`:
[ASS writer](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/AdvancedSubStationAlpha.cs),
[SSA writer](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/SubStationAlpha.cs),
[style serialization](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/Common/SsaStyle.cs).
These sources document the review and are not downloaded as runtime inputs.
The implementation uses independent Node text operations and ordinary file
fields, without a LibSE or .NET object model. It does not render styles, burn
subtitles or generate audiovisual media. Automatic playback negotiation is a
separate consumer and is not expanded by this fixture.

Only Actions execute the scenario. Component success does not grant full or
release acceptance.
