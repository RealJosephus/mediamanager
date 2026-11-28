# Storage contract

Storage extensions register a type and an adapter factory through
`context.register('storage', { type, create, defaults })`. Each adapter exposes
`stat`, `listPage`, `openRead`, `health`, `close`, and a frozen capabilities
object. Write and watch capabilities require their corresponding methods.
Every declared default mount supplies its own capabilities; a default does not
implicitly acquire write access.

Production target publication checks write permissions with a temporary plugin
host. During this check the factory receives `capabilitiesOnly: true` and
`existingRootsOnly: true`. It can return the configured adapter with its normal
capabilities before opening a connection or initializing a root. The host
reads the capabilities and closes the adapter.

Adapters that accept an ISO modification time through `write(path, bytes,
{ modified })` may declare the optional boolean capability `writeModified`.
Callers can verify the stored timestamp through `stat().modified`.

An adapter may implement `getSpace(path, { signal })` to report the capacity
of the filesystem or quota that owns a mapped directory. It returns
`{ freeBytes, usedBytes, deviceId, storageType }` or `null` if capacity is
unavailable. Both byte counts are nonnegative integers, using `bigint` for
exact large values. Device and storage descriptions are optional.

Identity prefixes may use `posix`, `windows`, or `uri` style. URI prefixes select
the longest matching scheme, origin and path prefix. The complete stored URI,
including its query spelling, remains the identity. The helpers exported from
`@mediamanager/plugin-sdk/storage/uri` map that URI to one opaque adapter name
and recover it without interpreting the query as virtual path segments. URI
sources are separate from portable File mount roots.

## Read owners and source responses

`openRead(path, options)` returns an asynchronous byte stream and an idempotent
asynchronous `close()`. It reports the actual content length, total size, range
and source version when known. Unknown lengths and versions remain unknown;
they do not imply random access or a stable revision. The caller owns the
handle until both consumption and close finish.

An adapter without a mount-wide `reliableVersion` guarantee may report
`versionReliability: 'strong'` on an individual `stat` result. Its `version`
must then identify that object's byte representation, and `openRead` with
`ifMatch: version` must prove that it returned that representation or fail.

An adapter may additionally implement `openResponse(path, options)` for sources
whose status and headers are part of delivery. It returns
`{ statusCode, headers, contentLength, stream, close }`. Its options include
`signal`, the original `rangeHeader`, `ifRange`, and source `requestHeaders`.
This response operation may return a non-success status and its body; ordinary
`openRead` continues to reject a failed read. Byte-only adapters use the VFS
response operation over their ordinary read owner.

The HTTP adapter performs its own network requests, redirects, decompression,
timeouts and cancellation. It reports delivery headers for the actual decoded
body and does not retain a compressed length after decoding. Releasing an
owner, aborting its signal, or closing the adapter drains its actual requests,
responses, decoders and sockets. Metadata storage is selected independently of
the source adapter.

## Watch owners

A storage adapter with `capabilities.watch === true` implements
`watch(path, { signal, onChange, onError })` and resolves to an owner with an
idempotent asynchronous `close()` method. Paths are absolute adapter logical
paths. A change callback receives `{ path, type: 'change' | 'rename' }`; it is an
invalidation, not a complete directory snapshot.

Every error callback must be `onError(error, { terminal: boolean })`.
`terminal: false` means the subscription continues and can report later changes.
`terminal: true` means the subscription has stopped; it must emit no more changes.
Consumers must use this explicit state rather than infer lifetime from an error
code. An error while creating a subscription rejects `watch()` and releases any
partially created handles. Abort and explicit close release handles without an
error callback.

The local plugin rejects a symlink or junction as a watch root. Within a watched
root it reports unsafe or inaccessible subtrees as nonterminal errors and stops
watching those subtrees while retaining valid directories. It never follows
links. VFS terminates its entire combined subscription when any backend reports
a terminal error, and treats a missing terminal state as an invalid response.

Local native callback names are validated segment by segment before resolving
relative descendants. Unknown or malformed names only invalidate the directory
already owned by that native watcher; diagnostics include `watchPath` and the
original `callbackName`. The Windows absolute self-name emitted for a deleted
directory releases that owned subtree without resolving the callback as a path.
See the pinned [Node 24.16.0 libuv implementation](https://github.com/nodejs/node/blob/v24.16.0/deps/uv/src/win/fs-event.c#L538-L554).
