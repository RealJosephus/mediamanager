# Official M3U tuner component evidence

Behavioral source: the designated `D:/jellyfin/src/Jellyfin.LiveTv/TunerHosts/`
`M3uParser.cs`, `BaseTunerHost.cs` and `M3UTunerHost.cs`, plus
`Emby.Server.Implementations/Library/MediaSourceManager.cs`. Their GPL-2.0-only
license is retained by the official package and repository license.

`m3u-native.test.js` executes the designated DLL's actual `M3uParser`,
`BaseTunerHost`, `M3UTunerHost`, `MediaSourceManager.GetPathProtocol` and typed
`ChannelInfo` JSON cache reader. The native process records input SHA-256,
assembly paths/hashes, full observed JSON, request headers, stream disposal and
private-input cleanup. Its HTTP handler and network classifier are controlled;
neither a real tuner nor a recording/transcoding executor starts.

`input.json` covers attribute order/casing/duplicates, comments and pending
EXTINF state, accepted/rejected schemes, channel/name/number precedence,
literal URL number fallbacks, CLR whitespace, duplicate channels and BOMs with
split byte input. Source cases cover manifest URLs with queries, custom/blank
user agents, local/remote classification, looping and capacity configuration,
and RTSP/RTP/UDP. Public channel JSON is compared in full. Media-source
comparison is limited to every field assigned by the M3U producer plus the
native constructor flags used by that producer and the three assigned stream
fields; full native JSON remains in the raw artifact. This does not prove a
complete public MediaStream DTO or a consumer's future playback projection.

The cache sequence uses actual native methods: force load, memory hit after
source failure, failed forced refresh, cold disk fallback, forced empty list,
retained old nonempty memory and cold disk after a short empty overwrite. The Node cache is additionally
fed to a new actual native typed reader, rather than only compared to expected
JSON. A separate native multi-host pass verifies case-insensitive type selection,
host order, retained duplicates within the first batch and deduplication against
earlier hosts. All filesystem writes belong to fresh private output roots. Existing
native/reference inputs remain unchanged.

The actual native OpenOrCreate writer does not truncate an old cache. A shorter
forced empty list therefore leaves the prior JSON suffix, and its cold typed
reader rejects that file with JsonException. Both engines preserve that failure
prefix; raw before/after cache bytes, lengths and hashes remain in the report.
Node SyntaxError from this JSON cache reader is compared to native JsonException,
and the native JSON serializer's omitted null fields use the same declared wire
projection as channel records. The valid first Node cache still goes through an
independent actual native typed reader.

`m3u.test.js` separately tests the installed and preinstalled package through
the normal PluginHost and mapped local storage. A real private HTTP server
supplies original bytes; tests cover shared bounded queues, independent chunk
memory and owners, headers/HEAD, cancellation, a pending byte read on disable,
late noncooperative fetch cleanup and tuner reservations. These Node lifecycle
checks are not native transport or public playback differential evidence.
The common bounded HTTP input now lives directly in
`packages/plugin-sdk/live-tv/raw-input.js`; both native SharedHttpStream branches
wait for the first nonempty upstream bytes before returning an opened lease.
Real Node cases cover held headers, first-byte preservation for retained owners,
zero-byte EOF failure, a non-success HTTP response body and close while the
first read is pending. These source-reviewed readiness checks do not execute
the native temporary recording/copy implementation.
Opening/retaining now reserves an input owner while byte participation starts
at the iterator's first `next`. A never-read public owner does not stall a real
HTTP fork reader. Active paused readers still bound upstream advancement.
Tests cover owner cancellation before reading, after the first chunk and while
a real upstream read is pending; EOF, shared read failure, an in-flight chunk
after reader close and the last-owner cleanup are separate cases. The formal
default consumer is additionally composed with the installed M3U package to
check string/null tuner host identities, capacity, retain and final reopen.
The native SharedHttpStream choice (TS extension or successful MP2T HEAD, with
sharing enabled and no loop) obtains independent fresh HTTP inputs. Only an
explicit retain shares one such input; DefaultLiveTvService owns original-key
reuse. Native LiveStream branches, including non-TS/manifest/looping/unshared
HTTP and RTSP/RTP/UDP, reserve capacity and describe an original source without
opening network bytes or supplying a fabricated byte stream. HEAD discovery
is repeated for each fresh provider open and carries no configured user agent.

The Node implementation keeps native channel-cache behavior, but shares HTTP
original bytes only in bounded memory. It deliberately does not port native
SharedHttpStream's temporary media recording. Configuration fields such as
AllowHWTranscoding and existing recording paths remain ordinary stored data;
this provider never executes an encoder or recorder. Source envelopes use
`mode: 'native'`; untouched internal SupportsTranscoding defaults are not a
declaration of available transcoding. Public consumer projection and actual
playback remain outside this slice. `phaseAcceptance` and `releaseAcceptance`
therefore stay false.

The declarative cache identity cases use `.` and `..`. Actual BaseTunerHost
appends `_channels` first, producing `._channels` and `.._channels` inside the
cache root. The native component records force-refresh output and a fresh
host's source-failure fallback with every cache byte, length and SHA-256.
Node then records both identities against fresh direct consumers, including
reading those exact native-produced bytes. Installed and official PluginHost
consumers separately require complete mapped cache contents, a fresh activation
after source removal, actual close and rejection of late work. These cases can
expose the current Node guard before either cache operation; an attempted case
does not certify its later cold-read steps.

Owned cache files must remain beneath their explicitly mapped cache root.
Path separators, colon and NUL remain rejected, with actual outer-cache bytes
preserved. Native Path.Combine can instead form a nested or escaping path from
those inputs. This restriction is not a compatibility exception or a claim
that the corresponding final release requirement is complete.
