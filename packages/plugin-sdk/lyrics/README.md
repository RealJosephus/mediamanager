Register a `lyric` extension with `context.register('lyric', provider)`.
The provider has a nonempty `name`, optional Int32 `order` (default 0), and:

- `search(request, { signal })` returns an array of
  `{ id, providerName, metadata, lyrics: { format, bytes } }`.
- `getLyrics(id, { signal })` returns `{ format, bytes }` or `null`.

`bytes` is a complete `Uint8Array`, including any original BOM. Each provider
must consume and close its upstream readers before its method settles. The
host copies the returned bytes/metadata and tracks calls through plugin
disable, replacement and shutdown. The supplied signal includes that lifecycle;
providers must honor it for remote work. There is no seekable CLR stream API.

The search request contains `mediaPath`, `songName`, `albumName`,
`albumArtistsNames`, `artistNames`, exact nullable `duration` ticks,
`isAutomated`, and an empty `providerIds` Map, as used by the retained audio
controller. The manual HTTP search asks all enabled providers in provider order;
it does not apply the library's automated-fetch settings.

`metadata` is nullable public lyric metadata: `Artist`, `Album`, `Title`,
`Author`, `By`, `Creator`, `Version`, nullable Int64 ticks `Length`/`Offset`,
and nullable boolean `IsSynced`. Use bigint for ticks outside the safe integer
range. Unsupported lyric formats are allowed and are skipped by the consumer.
Search replaces the parser's metadata with this metadata; direct remote reads
parse the response bytes without a search-metadata overlay.

Public lyric IDs use the provider name's invariant-lowercase UTF-16 MD5 GUID
followed by `_` and the provider's opaque result ID. Consumers pass only that
opaque part to `getLyrics`; IDs without `_` retain their complete spelling.
The host supplies no remote lyric provider by default. This contract does not
authorize media analysis, extraction, generation or recording.
