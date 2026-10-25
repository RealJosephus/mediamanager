# Current external subtitle encoding consumers

These neutral SRT byte inputs use Unicode signatures, unmarked UTF-16/32 and
traditional single-byte or multibyte encodings. `authoredEncoding` documents
how the input was prepared; it is not an expected detector label. Each input
contains ordinary independently written text and has no expected response.

The shared current text fixture executes the designated public
`ISubtitleEncoder.GetSubtitles` twice on actual HTTP byte responses, including
Native charset detection. Node uses its formal Local storage and PostgreSQL
HTTP runtime. Complete original-format responses and generated SRT, WebVTT and
JSON are compared in warm and cold generations, with real reader cancellation,
source-byte preservation, reverse readers and resource shutdown.

Encoding normalization may change the public original-format bytes to UTF-8.
The actual Native response supplies that expectation; stored input bytes must
remain unchanged. Detector labels, confidence values and implementation state
are not response consumers. Generated layout uses only the existing exercised
text-reader allowances.

Production detection uses the unmodified
[jschardet 4.0.0 package](https://github.com/aadsm/jschardet) under 0BSD and the
existing Node text decoders. The dependency lock retains the registry artifact
URL, version and SHA-512 integrity. Its original license ships in the package.
No .NET charset model, subtitle renderer or AV process is used in production.
This component does not establish full or release acceptance.
