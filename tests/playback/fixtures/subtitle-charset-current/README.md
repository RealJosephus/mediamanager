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

Production detection reuses the existing JavaScript stream detector in
`src/core/native-charset.js` and Node text decoders. The designated public
subtitle consumer takes the first result without the Playlist confidence
threshold. The original thirty inputs and their authored bytes remain
unchanged. Full public delivery bytes and converted text determine compatibility;
detector labels, confidence formatting and candidate details do not add a gate.
No subtitle renderer or AV process is used. This component does not establish
full or release acceptance.
