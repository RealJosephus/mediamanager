# Actual native refresh queue and HTTP observations

The queue recorder invokes the baseline `ProviderManager` and `BaseItem` from
the freshly isolated Release DLLs. Its dependency `IMetadataService` is controlled;
it does not host HTTP or execute native SQL. `refresh-queue-native.json` retains
equal-priority ordering, mixed priorities, provider cancellation and disposal.
The native priority queue is a quaternary heap and does not promise FIFO ordering
for equal priorities. Ordinary Movie metadata refreshes do not emit Folder
`RefreshStarted` or `RefreshCompleted` events.

`refresh-http-native.json` comes from three actual HTTP runs of independent copies
of a fully initialized native instance. `ControlledRefreshProvider` blocks the
first of four previously refreshed, pathless Movie items. The recorder compares
the HTTP 204 responses, execution order, cancellation trace, stored overview,
DateLastSaved and DateLastRefreshed before release and after the native process
exits. An isolated generated API key is used only in memory and in each disposable
instance. Remote Movie metadata fetchers are disabled for deterministic inputs.

The provenance files bind the source manifest, native assembly and diagnostic
plugin bytes. The reference source digest is
`e28a983db179b720c3b16d7416ee4112894a3115c4be6fe43c61c52e0d9a8313`;
the SDK is 10.0.401. No reference source or original instance is modified.

To repeat, build the diagnostic plugin with `JellyfinAssemblyDirectory` pointing
to the isolated baseline build. Run `tools/compat/record-refresh-queue.js` with
`--assembly-directory`, `--baseline-manifest`, `--output` and `--dotnet`. Run
`tools/compat/record-refresh-http.js` with `--instance`, `--jellyfin-dll`,
`--plugin-dll`, `--baseline-manifest`, `--output`, `--port` and `--dotnet`.
The HTTP output must be a fresh directory. The stopped instance must include its
recorded `initialization.json`, source digest, assembly hashes and tool paths.

`refresh-queue-http.test.js` compares these observations with real candidate
SQLite and PostgreSQL state, through real HTTP with a controlled administrator
authentication dependency. It separately injects SQL failures and performs an
independent process edit during a blocked refresh. Those candidate failure and
race tests have no matching native SQL-fault or cross-process oracle yet.

The recordings do not cover complete typed lifecycle hooks, first-refresh
ReattachUserData, Folder validation, the shared queue with user views, NFO/image
side effects, uncooperative providers or real client behavior. Dynamic timestamps
are compared as persisted changes relative to each run's fixed initial stamp;
their raw native values are retained in the recording's observation files.
