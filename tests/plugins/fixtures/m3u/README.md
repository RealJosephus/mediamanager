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
retained old nonempty memory and cold empty disk. The Node cache is additionally
fed to a new actual native typed reader, rather than only compared to expected
JSON. A separate native multi-host pass verifies case-insensitive type selection,
host order, retained duplicates within the first batch and deduplication against
earlier hosts. All filesystem writes belong to fresh private output roots. Existing
native/reference inputs remain unchanged.

`m3u.test.js` separately tests the installed and preinstalled package through
the normal PluginHost and mapped local storage. A real private HTTP server
supplies original bytes; tests cover shared bounded queues, independent chunk
memory and owners, headers/HEAD, cancellation, a pending byte read on disable,
late noncooperative fetch cleanup and tuner reservations. These Node lifecycle
checks are not native transport or public playback differential evidence.
RTSP/RTP/UDP leases reserve capacity and describe an original source without
opening sockets or supplying a fabricated byte stream.

The Node implementation keeps native channel-cache behavior, but shares HTTP
original bytes only in bounded memory. It deliberately does not port native
SharedHttpStream's temporary media recording. Configuration fields such as
AllowHWTranscoding and existing recording paths remain ordinary stored data;
this provider never executes an encoder or recorder. Source envelopes use
`mode: 'native'`; untouched internal SupportsTranscoding defaults are not a
declaration of available transcoding. Public consumer projection and actual
playback remain outside this slice. `phaseAcceptance` and `releaseAcceptance`
therefore stay false.

Owned cache files must remain beneath their explicitly mapped cache root.
Tuner IDs containing a path separator, colon, NUL or an entire `.`/`..`
component are therefore rejected for cache access. Native Path.Combine can
instead form a nested or escaping path from these inputs. This concrete owned
cache restriction is not a claim that a compatibility exception has been
accepted or that the corresponding final release requirement is complete.
