# Live TV extensions

Official and third-party ESM plugins register a `tuner`, `listings` or `channel` extension in `activate(context)` with `context.register(kind, extension)`. Supply nonempty `type` and `name` strings. Consumers use `type` to identify the provider implementation and resolve collisions. Import the same validators used by the host from `@mediamanager/plugin-sdk/live-tv/contract`. [Contract](../../../src/plugins/live-tv-contract.js)

## Provider methods

Each method may return a value or a promise. The final options object preserves caller fields and carries a signal combining request cancellation and plugin deactivation. The host rejects an already-aborted call before invoking the provider. Replacing, disabling or uninstalling a plugin closes admission, aborts work and waits for admitted operations and their resources. A stale extension rejects new calls with HTTP 503. Providers must cooperate with cancellation. [Host tests](../../../tests/plugins/live-tv.test.js)

| Kind | Required methods |
| --- | --- |
| Tuner | `getChannels(enableCache, {signal})`, `getChannelStream(channelId, streamId, currentLiveStreams, {source, signal})`, `getChannelStreamMediaSources(channelId, {signal})`, `discoverDevices(discoveryDurationMs, {signal})` |
| Listings | `getPrograms(providerInfo, channelId, startDateUtc, endDateUtc, {signal})`, `getChannels(providerInfo, {signal})`, `validate(providerInfo, validateLogin, validateListings, {signal})`, `getLineups(providerInfo, country, location, {signal})` |
| Channel | `getChannelFeatures({signal})`, `isEnabledFor(userId, {signal})`, `getChannelItems(query, {signal})`, `getChannelImage(imageType, {signal})`, `getSupportedChannelImages({signal})` |

A configurable tuner can implement `validate(tunerInfo, {signal})` and declare a boolean `isSupported`. Tuners that can return partial channel results may implement `getChannelListing(enableCache, {signal})` and return `{ channels, complete }`. Set `complete` to false when a source fails. Guide refresh can save the returned channels and will preserve existing rows that were absent from an incomplete listing. An empty complete listing authorizes normal stale-row cleanup.

Channel extensions may implement `getChannelItemMediaInfo(itemId, {signal})`, `getLatestMedia(query, {signal})`, `getCacheKey(userId, {signal})` and the pair `canDelete(item, {signal})` and `deleteItem(externalId, {signal})`.

List operations return finite arrays. Preserve UTC range values at their original fractional precision. Channel features return a native-shaped record, enablement and deletion checks return booleans, and channel images return `null` or owned `{bytes: Uint8Array, mimeType}` after closing the reader. A channel item result carries `Items`, `TotalRecordCount` and any other provider fields. Preserve explicit null collections and constructor defaults. Item `MediaSources` and the media-info callback use the envelopes below. Saved channel item metadata may contain a nullable or missing source ID or path. Opening a tuner source requires both.

## Channel items, caching and deletion

Channel metadata accepts `description`, `dataVersion`, `homePageUrl` and `parentalRating` (the native name or number). The optional string array `attributes` matches `Recordings` case-insensitively. `disableMediaSourceDisplay` is a synchronous marker. `supportsMediaProbe` preserves an existing runtime and invalidates saved sources for a non-live item with a path.

The items consumer supplies `{UserId, FolderId, SortBy, SortDescending, StartIndex, Limit}`. User GUIDs use N format, with the empty GUID for a userless request. `FolderId` carries the original nullable external ID. The consumer requests the complete provider result with null sorting and paging and `SortDescending: false`, then filters, sorts, counts and pages in SQL. `getCacheKey` takes a nullable user GUID and returns a nullable string. Together with `dataVersion` it selects a three-hour cache. A fresh typed nonnull entry skips the provider and item reconciliation. A new entry is written before materializing items, so earlier writes survive a later failure.

Providing `getLatestMedia` enables latest refresh. The consumer calls `getChannelItems` for the root and each root folder one level deep. The special sort for a name containing case-sensitive `Trailer` uses the final dot-separated component of `type`.

For ordinary deletion, the consumer calls `canDelete` before checking user permissions, then calls `deleteItem` with the original nullable `ExternalId`. External deletion precedes local metadata and database cleanup. The plugin activation owns the admitted operation through a client disconnect. The separate Live TV management route looks up the visible item directly. Channel roots apply their own deletion permission override. A userless API key can reach the library action. [Channel deletion cases](../../../tests/library/fixtures/channel-deletion/README.md)

## Source selection

A tuner lists upstream descriptors before opening an input. Preserve native fields such as `SupportsTranscoding` and `UseMostCompatibleTranscodingProfile`. Playback negotiation projects the client's flags and delivery URLs. The server owns FFmpeg processing and DVR scheduling.

| Envelope | Validation |
| --- | --- |
| `mode: 'native'` | Omit `profile` or supply `native` case-insensitively. Provide the upstream identity and path. |
| `mode: 'device'` | Supply a supported device profile. The media source ID starts with the profile and an underscore, matched case-insensitively. If the upstream URL supplies a nonempty `transcode` query value, it must match the selected profile. |

For example, a modern HDHomeRun with an HDTC model and `AllowHWTranscoding` enabled advertises `heavy`, `internet540`, `internet480`, `internet360`, `internet240`, `mobile` and the native source. The shared validator also accepts `internet720` for device providers. An original stream and a device-produced stream are both eligible for subsequent server-side negotiation. The validator rejects inconsistent profile identities, server encoder paths or output URLs, and plugin recording or transcoding executors. [Validator](../../../src/plugins/live-tv-contract.js) · [HDHomeRun source profiles](../../../plugins/hdhomerun/source.js) · [Tuner selection](../../../plugins/hdhomerun/tuner.js)

```js
const source = {
  mode: 'device',
  profile: 'internet360',
  mediaSource: {
    Id: 'internet360_channel_tuner',
    Path: 'http://tuner/auto/v1?transcode=internet360',
    Protocol: 'Http'
  }
}
```

## Opening and retaining an input

Pass the selected envelope to `getChannelStream` as `options.source`. Its `streamId` argument carries the original stream ID, including null, empty strings and whitespace. Return the selected source and its acquired lease.

```js
const lease = {
  ...source,
  tunerHostId, // configured host ID as a string, or explicit null
  stream,      // optional AsyncIterable<Uint8Array>
  async close() { /* release this consumer and wake pending reads */ },
  sharing: {   // optional, shared by every consumer of this input
    get enabled() { return originalInputIsAlive },
    async retain({signal}) { /* return another owned lease */ }
  }
}
```

The host validates the returned ID against the selection captured before the call. The consumer receives a detached media-source snapshot, the actual configured `tunerHostId`, an optional byte iterator and an idempotent close. Preserve an empty host ID exactly. A URL-only lease still owns tuner capacity. If opening fails, release any partial acquisition.

All leases on the same input return the same sharing object. `retain` takes its own signal and yields a distinct consumer with the same source ID and tuner identity. Each reader owns its own close. EOF, failure, final close or deactivation disables retention. The host closes late or invalid acquisitions, returns their iterators and drains admitted operations. Explicit close, abort, natural end and iteration failure also release the lease.

`@mediamanager/plugin-sdk/live-tv/raw-input` exports `NativeHttpInput`. Its `acquire(signal)` reserves an owner. With `primeFirstBytes: true`, acquisition waits for a nonempty chunk and rejects empty EOF. A reader starts participating at its first `next()` and can hold one queued chunk. A read already in flight may complete after its reader closes. An unread owner leaves other readers free to advance. The final owner closes the upstream. [Bounded input](raw-input.js)

The M3U plugin opens a fresh HTTP input or reserves a URL-backed source according to the tuner configuration. The playback service reuses a live input by original stream ID, tracks readers and, for eligible live byte streams, maintains a growing file for late readers. HDHomeRun can deliver modern profiles over HTTP or use TCP tuning and receive legacy RTP. [M3U fixture](../../../tests/plugins/fixtures/m3u/README.md) · [Playback buffer](../../../src/playback/live-stream-buffer.js) · [HDHomeRun playback test](../../../tests/playback/hdhomerun-device-native.test.js)
