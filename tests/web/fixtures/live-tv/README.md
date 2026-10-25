# Designated Web live original consumer

The new test serves the unmodified designated Jellyfin Web build and pinned
Chromium on separate origins. Its source/build/runtime/browser identities use
the existing same-run input loaders. A visible login, Live TV home card,
Channels view from its actual modern library menu, channel card and Play button
drive the actual client. Neither tokens, localStorage, player clocks, API
responses nor playback reports are
injected. The fixture uses `createWebServerFixture({populated:false})`: the
same-run stopped native database is transferred to fresh PostgreSQL and opened
through `startProductionInstance`. The movie fixture's repeated packet-copy
input preparation does not run. No native server starts in this consumer slice.

The tracked VobSub composite source (`source.mkv`, 1,896,947 bytes, SHA-256
`4a9a6e3be221f0d08506ca6bbd6d3ad73819c82605871e9fd981b7bf14399a6c`)
supplies its existing H.264 and first AAC compressed packets. Only controlled
CI preparation changes their container, with this exact argument shape:

```
ffmpeg -nostdin -hide_banner -loglevel error -y -i <tracked source.mkv>
  -map 0:v:0 -map 0:a:0 -c:v copy -c:a copy -sn -dn
  -map_metadata -1 -movflags +faststart <owned-temp/original.mp4>
```

The output path is checked inside a newly owned temporary directory before
`-y` is allowed. There is no encoder, filter, hardware decode or production
remux invocation. Actual ffprobe inspects both source and output, including
all selected packet sizes and payload SHA-256 values in order, codec/profile,
dimensions, sample rate, channels and duration. Every selected packet must be
identical. The MP4 is a **new container identity**, recorded with its own size
and file SHA-256; it is not described as byte-identical to the MKV. Source bytes
are hashed again during cleanup, and all preparation processes must exit and
close. The historical media recording supplies bytes only, not playback proof.

A private HTTP server exposes the playlist and MP4. The official M3U provider
is configured through real management HTTP with `AllowStreamSharing=false`;
the real Guide creates the channel. This is the reservation-only original
branch: the production registry owns a descriptor while actual ffprobe and
the browser independently fetch the original URL. Native SharedHttpStream,
recording, HLS, encoding and production packet-copy never execute. The browser
must really negotiate with its original `AutoOpenLiveStream=true` request,
consume the returned LiveStreamId, decode advancing H.264 video,
fetch original bytes, send start/progress/stop with LiveStreamId, and release
the public reservation. Original HTTP ranges retain their exact byte hashes.

The same browser reconnects after reopening the production entry at the same
origin. The fixture waits the actual sealed query client's declared freshness
interval before reload, then receives an authenticated WebSocket handshake, reads persisted live
UserData and plays/stops again. Live channels retain zero resume ticks and
Played=false while PlayCount advances. Media SQL rows must remain unchanged;
UserData uses the production `loadPostgresUserDataRows` GUID index selector;
all raw row IDs and columns are retained without rewriting their format.
Both actual client PlaybackInfo responses must retain RequiresOpening and an
opened LiveStreamId. The specified client deliberately skips explicit
LiveStreams/Open when AutoOpen already returned that ID. An additional real
public GET PlaybackInfo, made before each play with the explicit playback user,
records RequiresOpening/OpenToken and matches its source ID to the subsequent
AutoOpen result before the corresponding cache is inspected. This GET is an
independent observation lane, not a simulated client request. Before/after
snapshots retain hashes of all native SQL table values and private config/cache
files, plus complete media SQL rows; media/UserData and files must not change,
and any other changed table is recorded. UserData and actual
WebSocket notifications are retained separately. Shutdown
must release the browser, listeners, schema and owned input directory. The
independent anonymous browser HTTP request proves only the negative auth
response and absence of stream acquisition, not a denied Web UI workflow.

A separate observer attaches synchronously to each real production HTTP
server's `upgrade` event, including the newly opened server after restart.
It records each actual net socket's endpoint tuple, server owner and path
without query parameters, tokens or headers. Its real `close` event promise
must resolve within ten seconds after browser/runtime cleanup, with the socket
closed/destroyed and both servers no longer listening; the observer then
detaches. It never reads socket bytes or sends an end, destroy or WebSocket
close frame. Browser `websocket.close` timestamps remain the original observed
events; absent browser events are not filled from server observations. Public
registry/tuner ownership must independently be empty after runtime shutdown.

Unsupported codec/container, missing client routes, decode failure or a failed
reconnect is a test failure with actual page/API/WS/byte/probe evidence. No
fallback fixture response or simulated media success is used. This test does
not prove native SharedHttpStream transport, arbitrary tuners, weak networks,
recording or a complete release. All acceptance flags remain false.

Dispatch with `native_reference`, `native_instance`, `native_sqlite` and
`web_clients`; Linux can diagnose first, and final evidence requires all three
platforms. Do not execute validation locally.
