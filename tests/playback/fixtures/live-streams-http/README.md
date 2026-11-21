# Public original live streams

The test starts a private designated Native instance with empty timer documents, disables scheduled triggers through the API, installs a local M3U tuner and obtains the channel created by Guide refresh. Its stopped database seeds a fresh PostgreSQL schema. Node starts through the production entry point with the same mapped playlist. [HTTP comparison](../../live-streams-http-native.test.js)

With `AllowStreamSharing=false`, Native opens a reservation and ffprobe reads the supplied finite PCM WAV. The default service can reuse that reservation by OriginalStreamId. A blank original ID opens a fresh input with the same public source ID.

The comparison validates random PlaySessionId and trace IDs before mapping them. It asserts that this candidate source reports `SupportsTranscoding: false`, then sets that field to false on both sides for comparison. The raw HTTP observations preserve each server's advertised value. Status, content type, body, source ID, OpenToken, LiveStreamId and cache files are retained. A Native MediaInfo reader opens both servers' cache bytes, and Node reads the Native bytes.

For other stages of the same path, use the actual ffprobe bridge, retained-reader component and continuous-stream playback tests. [Probe](../../live-stream-ffprobe.test.js) · [Retained reader](../live-stream-retained/README.md) · [Playback and DVR](../../live-tv-dvr-native.test.js)
