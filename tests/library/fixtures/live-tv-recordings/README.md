# Existing recording directory readers

`Program.cs` executes the selected build's actual `RecordingsManager.GetRecordingFolders`, `LiveTvManager`, `LibraryManager` and EF SQLite `BaseItemRepository`. Synthetic rows, parent/ancestor relations, genres and real isolated directories are created for this recording. The Node test imports those exact repository rows into PostgreSQL and invokes the real `LiveTvRecordingsService` and `LibraryService` query/DTO path.

The native generic DTO builder is a declared control: it projects identity, name, kind, optional tags and four removable fields from the actual manager's DTO options after its query. Comparison uses only that same subset of the Node's actual DTOs. Full native generic DTO construction, all permissions and HTTP binding are separate consumer scopes. The empty `IChannelManager` control records both refresh-latest true/false calls; it does not implement or validate an installed external Channel provider, plugin enablement, provider refresh or dynamic streams.

Cases cover directory deduplication, newest exact-path source selection, cultural recording-folder order, video/nonvirtual/ancestor filters, owned and alternate suppression, presentation-key grouping, type include/exclude precedence, sports/kids genre union, ignored bound selectors, counts/offset/limit, userless reads, explicit in-progress reads without a recording executor, removed DTO fields, and a response spanning bounded SQL pages. An additional real PostgreSQL owner check changes a live row after capture and proves the later page retains the captured value. It verifies every page stays at most 128 rows and that the temporary table is released. Full business rows remain read-only after normal queries.

`live-tv-recordings-close.test.js` pauses actual service directory observation, replaces the named configuration through real XML I/O, starts close, and proves admitted readers drain while later scoped lookups see the current cache. Released scopes and new work remain unavailable. This is a lifecycle integration test, not native timing evidence.

`tests/http/live-tv-recordings.test.js` checks retained route binding and the real `AuthenticationService` access/management distinction with controlled authentication identities. Its PostgreSQL integration composes the action with actual item hydration, deletion, metadata cleanup, source retention and removal events, including an ordinary Audio item whose `CanDelete` is false. It does not claim a real native HTTP authorization or DTO comparison; that remains an independent acceptance scope.

Inputs and results are generated under the authorized validation output directory. The report binds native input bytes, executing assemblies and build source files; the private SQLite database/directories are removed after Node closes. No recording scheduler, recorder, tuner, stream or encoder is started. This component does not establish phase or release acceptance. Run only in the authorized Actions workflow.

The oracle requires the designated Jellyfin runtime's SQLite native image for the
current SDK RID. MSBuild copies that exact platform file into the isolated oracle
output and fails if it is absent. The process reads and hashes the copied image,
loads its absolute path and binds the SQLite provider's native imports to that
handle before `Batteries_V2.Init()`. It records filename, runtime identifier, bytes
and SHA-256 in `nativeLibraries`; a host-system SQLite fallback cannot satisfy
this fixture.

Sources: `D:/jellyfin/src/Jellyfin.LiveTv/{LiveTvManager,Recordings/RecordingsManager}.cs`, `Emby.Server.Implementations/Library/LibraryManager.cs`, `Jellyfin.Server.Implementations/Item/BaseItemRepository*.cs`, `MediaBrowser.Controller/{Dto/DtoOptions,Entities/Video}.cs`, under the project GPL license.
