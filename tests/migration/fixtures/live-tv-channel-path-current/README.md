# LiveTvChannel scalar HTTP identity through actual exchange

This Actions-only consumer reuses the existing neutral
`nonempty channel path suppresses the dynamic provider and final placeholder`
sample from `tests/library/fixtures/live-tv-media-sources/input.js`. Its declared
HTTP URI passes through the designated Native `LiveTvChannel` setters and the
real `BaseItemMapper` in that fixture's original Oracle project. The original
Mapper row, source bindings, input bytes, process record and Native static and
playback source results are retained. Tuner and user-data inputs remain
controlled component dependencies.

The complete same-run stopped Native SQLite input is privately copied with its
real schema and migration history. The actual Mapper row is inserted into that
copy without manufacturing a ChannelId. Production transfer imports the whole
database into fresh PostgreSQL with the original instance identity and empty
portable-mount contract. The production typed item/library consumer reads that
imported row and compares its static and playback sources with the Native
component results. Production export then produces a genuine reverse SQLite
database. All native table digests and the scalar URI's original bytes must
survive both transfers; the source input and imported data remain unchanged by
the source consumer.

`LiveTvChannel.GetMediaSources` uses its scalar Path and PathProtocol directly.
`LiveTvMediaSourceProvider` suppresses dynamic sources for a nonempty Path. These
contracts are independent of CanDownload. The ordinary Guide producer inspected
for this change does not assign an HTTP scalar Path; this fixture does not claim
that it does. It also does not start a Native HTTP server, open or decode media,
or establish every type/protocol's import policy. Only this exact Native type
joins the existing credential-free HTTP(S) scalar policy. Folder/unknown types,
credential URIs, FTP and storage protocols retain their existing refusals, and
opaque root Data.Path is not interpreted.

Typed item/library/linked owners drain before reverse exchange, and all SQLite,
PostgreSQL, input and private-file cleanup runs after either success or failure.
The two database copies live in a unique owned directory under the resolved
system temporary root, outside artifact output. Removal checks that root,
prefix and ordinary directory identity and runs only after typed, database and
store owners close successfully. If an owner or removal fails, the report names
the retained protected directory; database copies are not uploaded.
The published report retains partial observations without calling them a pass.
No fixed SQL count, CLR/private representation or diagnostic count is an
acceptance condition. This is a source-component and real exchange result, not
full Native HTTP, full-instance migration or release acceptance.
