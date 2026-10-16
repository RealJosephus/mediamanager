# Storage watch contract

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
