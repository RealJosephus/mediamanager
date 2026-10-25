# Public live byte and session runtime integration

This test creates a fresh real PostgreSQL schema and calls the production
`createRuntime` composition with a private program-data/configuration/cache
tree. It is runtime-assembly evidence, not a CLI import or a full native HTTP
comparison. The actual native SessionManager and retained/controller component
comparisons remain in `tests/sessions/live-stream-lifecycle-native.test.js` and
`tests/playback/live-stream-retained-native.test.js`.

The official M3U plugin is installed and activated by the real plugin host.
The test saves its mapped local playlist through the real TunerHosts HTTP API,
waits for the real RefreshGuide task to create the typed channel, discovers its
real OpenToken, and opens it through the public HTTP route. A handwritten PCM
WAV is served at an owned loopback `.ts` URL to select M3U's shared original-HTTP
branch; real ffprobe identifies the original WAV bytes through the private
reader bridge and creates the actual typed MediaInfo cache. No encoder runs.

After explicitly closing that finite warm-up reservation, the same OpenToken
opens a new held original HTTP input. A second public Open retains the same
input. Cache hits must neither open another upstream connection nor acquire a
probe reader. Public byte requests exercise the actual HTTP route and binary
result, not an injected Writable. The first reader receives the original
prefix. A later reader joins at the current stream position, then both receive
the same subsequent original blocks. It does not receive historical bytes.

Two real authenticated sessions report Start and exact-Int64 Progress while
paused, leaving the production automatic timers enabled. One byte reader is
cancelled without changing either public consumer. HTTP Stop closes one public
owner while the second session and byte reader continue. Two actual WebSockets
share that second session: closing the first leaves it alive; closing the last
executes real controller detach, SessionEnded and last-owner cancellation.
The administrator observes real Sessions messages. UserDataChanged messages,
HTTP UserData, actual PG rows and the absence of invented Stop writes on
disconnect are checked independently. Live channels preserve zero resume
position and unplayed state even when Progress contains ticks above 2^53.
Report bodies follow the designated Web `playbackmanager.js` reportPlayback
shape (PlayState fields plus ItemId, without a prebuilt Item DTO); that is
source-backed input preparation, not an executed Web client.

A final real Open/Start keeps a byte read and WebSocket active during
`runtime.close()`. The test waits for HTTP/WS/upstream closure, an empty public
registry and a closed listener/database. It then reopens the real PG schema
and checks that the committed UserData rows survive unchanged. The playlist,
typed media cache and complete persistent private file inventory retain their
bytes. The diagnostic plugin-host lock is bound to this actual PID and its
original hash, then must disappear on shutdown; it is the only permitted file
removal. Original media are never spooled. Every fixture transport is released in
finally and the owned temporary tree/schema are removed.

The source HTTP response controls when finite or held chunks are delivered;
it is not a physical tuner or an executed native SharedHttpStream. No recording,
spool, transcode, packet-copy, browser playback, full native byte HTTP or release
acceptance is claimed. JSON receipts retain HTTP/WS observations, SHA-256 byte
evidence, actual SQL readbacks, errors and cleanup; credentials are not retained.
Only Actions executes this integration. `postgres` is the validation service;
ffprobe is discovered through the launcher's real media-tool boundary.
