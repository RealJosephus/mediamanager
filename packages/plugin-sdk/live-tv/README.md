# Live TV extensions

Official and third-party packages use the same `activate(context)` and
`context.register(kind, extension)` path. The kinds are `tuner`, `listings` and
`channel`. Each extension has nonempty `type` and `name` strings. `type` identifies
the provider implementation; it is not a package identity, channel identity or
public media source type. Consumers resolve provider type collisions explicitly.
The host does not choose providers, update guide rows, install scheduled tasks or
publish playback capabilities merely because a package registers these kinds.

The executable contract is exported by
`@mediamanager/plugin-sdk/live-tv/contract`. Its facade re-exports the core
implementation so registration and package-side validation cannot drift.
It follows the method responsibilities in the designated Jellyfin
`MediaBrowser.Controller/LiveTv/ITunerHost.cs`, `IListingsProvider.cs`,
`MediaBrowser.Controller/Channels/IChannel.cs`, `IRequiresMediaInfoCallback.cs`
and `MediaBrowser.Controller/Library/ILiveStream.cs`. The Node resource and
cancellation forms below are explicit; native CLR objects are not loaded.

## Methods and cancellation

Methods may return a value or a promise; consumers await them. Every options
argument is an object. The host preserves its other fields and combines
`options.signal` with the plugin activation signal. An already canceled call is
rejected before entering the provider. Disabling, replacing, clearing or
uninstalling a plugin revokes admission, aborts outstanding work and waits for
the provider and owned resources to finish. A stale extension rejects new work
with status 503. Cancellation requires provider cooperation; trusted in-process
code cannot be forcibly terminated.

| Kind | Method | Required |
| --- | --- | --- |
| tuner | `getChannels(enableCache, {signal})` | yes |
| tuner | `getChannelStream(channelId, streamId, currentLiveStreams, {source, signal})` | yes |
| tuner | `getChannelStreamMediaSources(channelId, {signal})` | yes |
| tuner | `discoverDevices(discoveryDurationMs, {signal})` | yes |
| tuner | `validate(tunerInfo, {signal})` | optional configurable tuner |
| listings | `getPrograms(providerInfo, channelId, startDateUtc, endDateUtc, {signal})` | yes |
| listings | `getChannels(providerInfo, {signal})` | yes |
| listings | `validate(providerInfo, validateLogin, validateListings, {signal})` | yes |
| listings | `getLineups(providerInfo, country, location, {signal})` | yes |
| channel | `getChannelFeatures({signal})` | yes |
| channel | `isEnabledFor(userId, {signal})` | yes |
| channel | `getChannelItems(query, {signal})` | yes |
| channel | `getChannelImage(imageType, {signal})` | yes |
| channel | `getSupportedChannelImages({signal})` | yes |
| channel | `getChannelItemMediaInfo(itemId, {signal})` | optional media-info callback |

The signal positions are kind-specific. In particular, tuner `validate` and
listings `validate` have different argument counts; none uses the metadata
provider method map. The optional tuner `isSupported` field is boolean. Native
channel description, data version, home page and parental rating may be retained
as provider data; they do not add execution capabilities. UTC range values are
passed unchanged, including full fractional precision; a provider must not
truncate them through a JavaScript `Date` merely to forward them.

`getChannels`, `discoverDevices`, `getPrograms` and `getLineups` return finite
arrays of the corresponding native-shaped data records. `getChannelFeatures`
returns native-shaped feature data; `isEnabledFor` returns boolean;
`getSupportedChannelImages` returns image types. `getChannelItems` returns
`{Items, TotalRecordCount}` and preserves other data fields. Each item's
`MediaSources`, when supplied, uses the source envelopes below. The media-info
callback returns the same source envelope array. No returned data record owns
an open upstream. `getChannelImage` returns `null` or finite owned
`{bytes: Uint8Array, mimeType}`; the provider closes image readers before
returning bytes, as with a dynamic metadata image provider.

## Original sources and owned live streams

`getChannelStreamMediaSources` and the channel media-info callback return:

```js
[{ mode: 'native', profile: 'native', mediaSource: {
  Id: 'native_channel_tuner', Path: 'http://tuner/auto/v1', Protocol: 'Http',
  SupportsTranscoding: true, RequiredHttpHeaders: {}
} }]
```

`mode: 'native'` declares that opening the source obtains original upstream
bytes without recording, buffering to a recording, re-encoding or delegating
those operations to an external service. `profile` is optional; when present,
it must be `native` (case insensitive). A known HDHomeRun encoded source ID,
non-native `transcode=` URL, encoder path or encoded output URL/container is
rejected while listing sources and before invoking the tuner open operation.
Profiles such as `heavy`, `mobile` and `internet720/540/480/360/240` cannot be
advertised or opened by changing a flag on an encoded source.

The envelope is an internal source assertion, not a public `MediaSourceInfo`
projection. Native DTO values are preserved, including constructor defaults
such as `SupportsTranscoding: true` and `UseMostCompatibleTranscodingProfile`.
Preserved tuner options such as `AllowHWTranscoding`, historical recording
paths, unknown configuration and existing media are not execution permissions.
A later playback consumer must project unsupported public capabilities as false
and omit unavailable URLs; this extension registration does not perform that
projection or advertise a playback endpoint. There are no recording or
transcoding executor registrations or open methods in this contract.

To open a source, pass its chosen envelope as `options.source`. The method's
`streamId` argument is the native OriginalStreamId: a nullable string, including
an empty or whitespace string, passed unchanged to the provider. It is distinct
from the selected `mediaSource.Id` used to validate the actual opened source.
An OriginalStreamId does not authorize an encoded source or weaken native-source
validation. The provider returns an already opened lease:

```js
{
  mode: 'native', profile: 'native', mediaSource, tunerHostId: 'configured-tuner-id',
  stream, // optional AsyncIterable<Uint8Array> over original upstream bytes
  async close() { /* release this consumer and unblock its pending read */ },
  sharing: { // optional stable capability for this original input
    get enabled() { return originalInputIsAlive; },
    async retain({signal}) { /* acquire a distinct owned consumer of this input */ }
  }
}
```

The returned source identity must match the selection captured before invoking
the provider; mutating a pending selection cannot authorize a different source.
Every opened lease includes `tunerHostId`, a string or explicit `null`. Empty
strings retain their value; a missing field or another type is rejected. This is
the actual configured tuner identity, independently of its provider type and
the selected media-source identity. Consumers preserve it as native
`TunerHostId` when supplying current live streams for tuner capacity checks.
The host freezes this primitive in the returned lease.
A URL-backed lease may
omit `stream`; it still owns and releases its tuner/session reservation. Every
open call returns a separate ownership lease. A provider sharing an upstream
with `currentLiveStreams` manages its own reference counts and must not transfer
another consumer's close ownership. It must release partial acquisitions before
rejecting an open call.

The optional `sharing` object represents an original input, independently of
the caller that acquired its first lease. All leases from that input return
the same object. `enabled` is a live boolean: it becomes false at original HTTP
EOF/failure, final consumer close and plugin shutdown. `retain({signal})`
acquires a new consumer, with its own iterator, cancellation and idempotent
close. It returns the same native source identity, exact nullable tuner host
identity and the same sharing object.
A second call to an existing iterator is not a new consumer. The capability
itself holds no extra reference: retaining a closed input must fail and cannot
restart or replace its upstream. After one consumer closes or cancels, its
capability remains usable while other consumers still own that input.

The host exposes a stable sharing facade and wraps every retained resource
through the same native/identity/ownership checks as a new open. Each retain
combines its own caller signal with the plugin scope signal; it does not inherit
the first caller's signal. Already canceled requests never enter the producer.
Late, canceled, invalid or wrong-input results close their resource and return
their iterator before rejection. Disable revokes retention immediately and
drains admitted retains and every consumer, including late results. Providers
must release or wake their pending reads during close; noncooperative trusted
code cannot be forcibly terminated.

Native `EnableStreamSharing` is an input lifecycle property, distinct from
the tuner option `AllowStreamSharing` that selects native SharedHttpStream
transport. Native URL-only LiveStream descriptors can also be retained. For
example, an RTSP/RTP/UDP producer can retain a tuner reservation and source
description without opening a network byte stream. The official M3U producer
retains independent HTTP byte consumers in bounded memory for the native
SharedHttpStream branch. Other native LiveStream branches, including HTTP
manifests, looping and disabled sharing, retain source reservations without
opening network bytes. Each fresh provider open creates a separate input;
only retain shares that precise input. The producer does not run a loop,
encode media or record temporary media. OriginalStreamId matching, ordered
first-match choice, consumer registry/counts and public open/close APIs belong
to the owning consumer rather than the plugin host.

The shared bounded HTTP input is exported directly as
`@mediamanager/plugin-sdk/live-tv/raw-input`. `NativeHttpInput.acquire(signal)`
reserves an owner and returns `{stream, close}` after opening; SharedHttpStream
producers use `{primeFirstBytes: true}` to wait for a nonempty first chunk and
reject zero-byte EOF. Its iterator becomes a byte consumer only on its first
`next()`. An owner which has never read does not apply backpressure. Once a
reader starts, its one queued chunk blocks subsequent reads until consumed or
closed. Closing a reader releases its owner without closing another owner's
upstream. The final owner closes and drains the input; no background drain or
media spool is used. One read already in flight may finish after its reader
closes; at most that chunk is retained for the next reader. New readers join
the current byte position; this owner primitive does not replay prior stream
history. EOF/failure disables sharing and is observed by remaining owners.

The host exposes a detached media-source snapshot, an owned byte iterator and
an idempotent asynchronous `close()` and the declared optional sharing facade.
It does not expose other methods on the provider's lease. Explicit close,
request abort, natural end, iteration failure
and plugin shutdown all close that lease and return its iterator. The last
upstream owner closes the underlying input. Close must
unblock pending reads. A resource arriving after request cancellation or plugin
shutdown is closed before its open operation rejects; it is never delivered to
the caller. An invalid opened response is also closed before rejection. Close
failures are retained, all other owners still drain, and the normal plugin
transaction/recovery contract remains in force.

These rules establish the shared plugin boundary. They do not establish a
working external tuner/listings implementation, persisted guide refresh,
public stream/closing endpoints, browser playback, recording execution or final
Live TV acceptance. The dedicated host tests exercise package admission,
method-specific cancellation and actual owned-resource shutdown without
contacting a tuner or starting any media executor.
