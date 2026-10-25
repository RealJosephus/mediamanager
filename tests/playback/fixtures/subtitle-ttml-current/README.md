# Current TTML output text consumers

These neutral text inputs request explicit TTML output from the designated
public subtitle encoder and the formal Node Local/PG HTTP runtime. They reuse
the separate current text and ASS/SSA writer inputs, then add the nine alignment
regions, XML text, inline font markup and incomplete markup. Full, cropped and
timestamp-preserving requests retain complete original responses in both warm
and cold generations. Expected conversions and errors come from two actual
Native executions in the same Actions run.

The Native readback of these named TTML writer bodies calls the real public
`TimedText10.LoadSubtitle` and the existing public JSON writer. It does not claim
that the designated generic subtitle parser registers the `ttml` extension.
The explicit Node fixture reader uses the existing XML parser to read actual Native writer files;
both readers compare complete public cue text, markup and time. The complete XML
structure also compares namespaces, elements, attributes, styles, regions and
mixed text. Only XML line endings, attribute order, namespace-prefix spelling,
empty-element spelling and whitespace-only nodes between elements are projected
unless `xml:space="preserve"` applies. Text-bearing nodes keep all their spaces.
Actual reader
results must independently agree before this generated-file allowance passes.
Original-format bodies and stored source bytes remain exact.

The fixture shares the isolated real HTTP input host, charset reader, source
binding, current assemblies, public error middleware, real client cancellation,
reader ownership, PG cold reopen and complete process/storage/database cleanup
from the [current text fixture](../subtitle-text-current/README.md). It does not
use a Native full MVC host or file-protocol input. No renderer, subtitle burn,
OCR, AV encoder or locally generated media is involved.

The behavior review uses libse 4.0.12 (LGPL-3.0), whose NuGet metadata identifies
SubtitleEdit commit `6305d8ff4df1c7e7b55cf6d647ac6c95464071b1`:
[TTML writer and text reader](https://github.com/SubtitleEdit/subtitleedit/blob/6305d8ff4df1c7e7b55cf6d647ac6c95464071b1/src/libse/SubtitleFormats/TimedText10.cs).
This link records the reviewed source; runtime inputs are the declared same-run
assemblies and sealed Native source offer, not new downloads or a local cache.
Production uses ordinary Node XML/text operations without a LibSE object model.
The generated-body reader is a fixture consumer, not an additional production
input format or a clone of a Native paragraph object.

This component covers TTML output and the stated writer-body readers. It does
not establish generic TTML input delivery, automatic playback negotiation, full
acceptance or release acceptance. Tests execute only in Actions.
