# Official HDHomeRun component evidence

The official package follows the designated GPL-2.0-only sources in
`D:/jellyfin/src/Jellyfin.LiveTv/TunerHosts/HdHomerun/`, `BaseTunerHost.cs`,
`SharedHttpStream.cs`, `LiveStream.cs`, `Jellyfin.Networking/Udp/SocketFactory.cs`,
the typed `ChannelInfo`/`MediaSourceInfo` models and Jellyfin JSON converters.
The test records current source bindings, input SHA-256, actual assembly hashes,
native results, real HTTP requests and UDP payloads. It is run only in Actions.

`hdhomerun.test.js` activates installed and preinstalled packages through the
formal PluginHost and configured local storage mount. Device/lineup/cache
requests use actual isolated HTTP sockets. Its actual designated DLL oracle
runs in an owned Worker, so synchronous .NET build/execution never blocks the
HTTP server. The native handler routes only the discovered sender's port-less
HTTP endpoint into that same isolated server; the original URI is retained.
The native SocketFactory sends the actual 20-byte broadcast to UDP 65001. A real
UDP fixture answers with too-short, wrong-kind and duplicate accepted packets.
The test requires actual native packets, two device HTTP requests and two
devices; no empty environmental discovery result is counted as coverage.

Model/lineup cases include exact property casing, defaults, duplicate known
properties, an invalid earlier duplicate, numeric boolean conversion, quoted
Int32, null roots/members and response-status differences. Actual BaseTunerHost
sequences cover memory retention, cache bypass, old memory after empty refresh,
OpenOrCreate short writes with a retained invalid suffix, strict typed cold cache
reads, favorite/DRM filtering, duplicate channels and earlier-host precedence.
One cache is first produced by the installed Node plugin through its mapped
storage, embedded byte-for-byte in the hashed oracle input, and consumed by a
fresh actual native BaseTunerHost typed fallback reader after a real HTTP 503.
Validation demonstrates device-ID mutation, 404 suppression, null failure and
model-cache clearing without clearing the channel cache. Source comparisons
include every field assigned by the HDHomeRun producer and relevant constructor
defaults; full raw native MediaSourceInfo JSON is retained. This producer-field
projection does not prove a complete public MediaStream DTO.

The native protected stream factory is invoked to construct actual
SharedHttpStream and HdHomerunUdpStream objects. Their selected class, original
identity, source, tuner identity, sharing flag and initial consumer count are
inspected; each is closed/disposed. `Open` is never invoked: the native modern
SharedHttpStream writes a temporary recording/copy file, and the legacy path
tunes TCP and receives/copies RTP to a temporary file. Recording/copy executors
are excluded. Native hdtc encoded profile descriptors remain in the raw report;
the six excluded profiles are explicitly recorded, while the retained native
descriptor is compared. Node rejects encoded or legacy execution with the typed
400 `not-supported` contract before opening those network paths. It preserves
device configuration and native media-source capability fields.

Modern original HTTP delivery uses the shared SDK raw-input owner without
writing a recording/spool file. Real Node HTTP tests verify first-byte readiness
after held headers, zero-byte EOF failure, non-2xx body delivery, bounded shared
chunks, independent retained owners, tuner limits, disabling during a pending
first read, late response cancellation and resource cleanup. These checks do
not claim actual native recording execution or public playback HTTP parity.
HDHomeRun always selects its SharedHttpStream branch for modern lineup URLs;
AllowStreamSharing and EnableStreamLooping do not change that native selection.
Acquisition reserves ownership; byte backpressure starts at the first iterator
read. An unread open owner does not block a probe/HTTP reader. The formal
default consumer and installed package are composed to verify both string and
null host identity, tuner capacity, retained ownership and final reopen. Native
discovery records actual errors/socket codes, bound endpoints/broadcast flags,
socket-handle disposal and available IPv4 interfaces, including failed runs.
The discovery duration uses the native Guide scan's 3000 ms. A missing physical
broadcast remains a hard failure, with full diagnostics retained; increasing
the observation window does not certify an empty result.

Cache identities containing path separators/NUL/ADS syntax are rejected at the
owned cache boundary; this is an explicit functional difference. Discovery does
not discard packets using a separate userland count threshold. No physical tuner, encoding profile,
legacy TCP tune, recording executor or complete public playback is certified by
this component fixture. Reports keep phase/release acceptance false.
