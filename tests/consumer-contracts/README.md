# Consumer reader and date evidence

The fixtures contain additional measurements. Existing native recordings, oracles,
and expected differences were not replaced. `fixture.js` verifies the copied bytes
against their external recordings and provenance, including the actual oracle,
runtime, and loaded reference assemblies. `candidateVerified:false` and
`phaseAcceptance:false` describe the recording boundary; passing these tests does
not promote that boundary to a release acceptance.

The recorder binds the original source bytes. When a source path has moved,
`MEDIAMANAGER_RECORDED_SOURCE_ARCHIVE` supplies files named by their SHA-256;
the recorded digest remains the verification gate. The committed reproduction
source uses descriptive comments.

`fixtures/readers` uses the current controlled Jellyfin build to read real Node
password hashes, task JSON, configuration XML, generated subtitles, and WPL/ZPL.
The reverse direction uses actual native output. JSON observations retain Int64,
float32 and double negative zero, seven-digit dates, null dictionaries, surrogate
replacement, and non-finite rejection. There are 590 subtitle layout inputs,
including actual captured HTTP bodies; empty filtered documents still fail. The
configuration records preserve a counterexample: native reserialization drops
unknown elements, while the Node store retains their namespace, attributes, text,
and order. No XML writer or configuration conflict detector was replaced.

`fixtures/playlist-layouts` adds 24 actual PlaylistItemsProvider inputs. The native
record includes linked children and all 72 mapper columns. The companion reader
record sends actual Node WPL/ZPL output through PlaylistsNET, native reserialization,
and Node parsing, including duplicate links and attribute-order variants. This is
sidecar and mapper evidence, not an actual native SaveItems transaction.

`fixtures/date-roundtrip` captures real HTTP POST/GET, PostgreSQL rows, a complete
32-table SQLite transfer, native takeover and continuing writes, and reimport.
The native host used Taipei; Node Taipei matches, while Node Shanghai saves a
different value for the 1900 input. The raw `compatible:false` remains a
measurement result. Historical timezone differences are accepted under the
[Node.js date policy](../../.agent-docs/README.md#差异如何判定); these records are
diagnostic evidence and require no further historical timezone validation.

Fresh HTTP delivery evidence comes from `tests/images/http.test.js`,
`tests/playback/http-native.test.js`, and `tests/playback/hls-http.test.js`.
HLS layout tests run the actual pinned FFprobe against HTTP manifests and real
runtime segments, comparing all packets and stream values with the baseline.
The reader uses `-http_multiple 1`, and the HTTP test verifies overlapping segment
requests. Earlier timeouts remain in the validation output: holding the job lock
through a backpressured response blocked the reader's next segment. Selection is
still serialized; independent response leases drain before cache removal. The
lifecycle tests cover backpressure, finish/cancel/stop/close, and reliable/weak
versions. Original/copy-only subtitle bytes,
media packets, job identities, and opaque validators retain their original gates.
