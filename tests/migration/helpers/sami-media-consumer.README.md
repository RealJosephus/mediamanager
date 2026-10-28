# Discovered SAMI media consumer

`sami-media-consumer.js` supplies two new UTF-8 BOM `.smi` inputs for the real
`native-media-access.test.js` WebDAV and AList exchange branches. The initial
source is discovered and probed during the formal Node metadata refresh; no
Subtitle stream is inserted to establish that path. The full saved stream rows,
POST PlaybackInfo request and response, negotiated WebVTT response, explicit
WebVTT and JSON cue responses, original bytes and hashes are retained for every
observed stage in `sami-media-consumers.json`.

Requests use the canonical `Authorization: MediaBrowser Token` header on both
servers, as do the surrounding native media-access observations. The supplied
Native instance disables legacy authorization, so an `X-Emby-Token` request is
rejected before reaching the subtitle consumer. Run `40219245224` retains that
original fixture-input failure; later candidates must run the complete chain
with the same media and subtitle bytes.

Each stage also fetches the formal HLS subtitle playlist with a one-second
segment length, resolves the first segment URI supplied by that actual
playlist, and fetches its WebVTT body. The record retains the complete playlist
text and segment bytes, Content-Type and length, source crop parameters and
timestamp map. Node and Native compare the complete playlist through the
existing proved manifest projection and the complete segment through the
proved generated-WebVTT projection. These subtitle routes do not start an
audio/video HLS job. PlaybackInfo and playlist bodies stay textual for the
existing private-root report redaction; token-bearing bodies are never encoded
as base64 in the retained report.

The same source is exported with the database, restored, refreshed by the
designated Native server and read through its public HTTP consumers. A changed
source is then written at the Native return location and actually refreshed and
consumed. Its state passes through the reverse package and fresh PostgreSQL
import, where the formal Node runtime consumes it before and after refresh.
Both storage protocols use this chain. Existing complete table digests and
process, connection, schema and listener cleanup still apply.

Original-format bytes, including the explicit UTF-8 BOM, remain exact. Generated
WebVTT compares the complete body using the existing proved line-layout
projection; JSON compares the complete public TrackEvents including ticks,
markup and text. Native responses supply the expected generated values. A
changed source must produce changed public cue bytes. The helper does not
construct LibSE objects or predict a final-cue timing formula.

The same discovery and exchange branches also provide `feature.it.sami`, with
the original two BOM-marked sources. Each of its six stages first requests
`Stream.sami`: it ensures a readable SRT in `data/subtitles`, then the unsupported
SAMI writer returns 400. The initial Node request starts with no SRT or metadata;
later requests may reuse the actual restored or generated cache. The helper retains before/after state, the complete SRT and
`.meta` fingerprint, consumes SRT/VTT/JSON, negotiated delivery and the actual
HLS segment, and compares their complete values with Native. Raw cache bytes and
public SRT bytes remain separate observations: the existing charset reader may
transform delivery bytes. SRT consumption must preserve the persistent cache
and fingerprint; the unsupported response's status, MIME type and body remain
observable. Both state-package
restores compare the entire SRT and fingerprint bytes before starting the next
runtime. The records are separate in `sami-fallback-media-consumers.json`.
Branch diagnostics retain the actual error value and the originating request's
method, route and response phase. An expected writer failure is associated with
its real HTTP request rather than inferred from an empty log or an error count.

The `.smi` original route remains byte-exact. `.sami` is never added to the
original-subtitle access plan: its public same-extension request performs a
different conversion and writer-failure lifecycle. The two paths require their
own real probe, storage, process and persistent-state evidence. No subtitle
rendering, audio/video encoding or full-library acceptance is implied. Only
GitHub Actions executes the scenario.
