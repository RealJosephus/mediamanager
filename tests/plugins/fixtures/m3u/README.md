# M3U tuner fixture

The native oracle calls the designated GPL-2.0-only Jellyfin M3uParser, BaseTunerHost, M3UTunerHost, path protocol classifier and typed ChannelInfo cache reader. HTTP responses and network classification are controlled. The comparison records source and assembly hashes, request headers, input bytes, full channel JSON and the media-source fields assigned by the producer. [Native comparison](../../m3u-native.test.js) · [Inputs](input.json)

## Parsing and cache

- Playlist cases vary attribute order and casing, duplicate keys, comments, pending EXTINF state, whitespace, BOMs, channel identifiers and URL schemes. Source cases cover manifests with queries, user agents, looping, capacity and local/remote classification.
- Forced loads, memory hits, failed refresh, cold disk fallback and empty results exercise cache lifetime. A shorter native OpenOrCreate write leaves the old suffix. Both readers reject the resulting invalid JSON. A fresh Native reader also consumes a valid cache written by Node. Multi-host cases check case-insensitive type matching, within-host duplicates and earlier-host precedence.
- IDs `.` and `..` produce `._channels` and `.._channels`. The comparison captures the Native cache after refresh and cold fallback, then gives the same bytes to a fresh Node reader. Installed and official package cases exercise mapped storage and reactivation after source loss. Node rejects path separators, colon and NUL in cache names.

## Input ownership

The Node package test opens real private HTTP inputs through PluginHost. A non-looping TS stream with sharing enabled can use a shared byte input, selected by extension or a successful MP2T HEAD. Each fresh open performs its own discovery and reserves an input. Retaining shares that particular input. Other cases, including manifests, looping, disabled sharing and RTSP/RTP/UDP, return a source reservation. HEAD discovery omits the configured user agent. [Package tests](../../m3u.test.js)

The shared HTTP reader waits for a nonempty first chunk. A reader participates in backpressure after its first `next()`. Tests cover held headers, empty EOF, non-success HTTP bodies, independent owners, late reads, disable during open and final cleanup. The source envelope uses `mode: 'native'` and preserves the producer's SupportsTranscoding value. The playback service negotiates downstream delivery. [SDK contract](../../../../packages/plugin-sdk/live-tv/README.md) · [Live playback and DVR](../../../playback/live-tv-dvr-native.test.js)
