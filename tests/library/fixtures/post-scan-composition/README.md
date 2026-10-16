# Nonempty eight-task composition

This fixture runs Actions differentials; source changes alone do not constitute
a recorded pass or release admission. The test builds and executes `Oracle.csproj` against
the Jellyfin runtime supplied by the same CI run. It retains fresh `record.json`,
build/process logs, raw `native.json`, the native SQLite databases and a candidate
receipt below `MEDIAMANAGER_VALIDATION_OUTPUT_ROOT`. Each input has its own fresh
oracle execution, `record.json`, `candidate.json`, `comparison.json`, and candidate
`cleanup.json`; the successful creation/cleanup input and cancellation input never
share a case root, native database, PostgreSQL schema, or cancellation source.
The music input also has a separate `post-scan-composition-music-*` receipt and
does not change either existing input's bytes or recorded outcome.

`NativeScanHost.cs` derives from the actual eight-service host recorded in
`post-scan-composition-native-1` on 2026-10-16. The previous empty/ordinary
recordings are not inputs or expectations for this test. This new source fixes
the by-name application paths to their real singular names, installs the actual
Genre and Studio metadata services, and replaces the former unused external
deletion seam with the real `ExternalDataManager` and `PathManager`.

The ordinary scenario saves a detached Folder with one Genre and one
Studio through native `ItemPersistenceService`. It also saves two unreferenced
by-name items, writes source/internal/extracted marker files, and inserts an
unmapped ItemValue. An empty-root global scan must then create both live by-name
items, refresh them, delete both dead items and their files, and remove the orphan
value. All eight actual post-scan exports remain registered in their discovered
order and are dispatched by `LibraryManager.ValidateMediaLibraryInternal`.

`music-input.json` adds two detached Audio rows through the same actual native
persistence service. Their performer and album-artist names use both native
artist relation kinds; their different runtimes and overlapping genres require
real child aggregation. Only this input installs the actual
`ArtistMetadataService` and `MusicGenreMetadataService`. The Artists task must
create and refresh both by-name artists, select the real tagged Audio children,
persist cumulative runtime and deduplicated genres, and delete an unreferenced
Artist with real source/internal/extracted marker files. The later MusicGenres
task must create and refresh the two music categories. Ordinary Genres must
continue to exclude these music-only names. The native trace must show Artist
metadata completion before MusicGenres starts; fresh native SQL and file output
remain authoritative for the complete candidate comparison. This is metadata
over persisted Audio rows, not audio-file resolution, probe or playback proof.

`cancellation-input.json` preserves the same nonempty operations but requests
cancellation at the new Studio's actual metadata-service entry. `GetStudio` has
already committed the item and directory, and the Genre task has already
completed its real refresh and dead-item cleanup. The observation wrapper only
cancels the actual global token source and still forwards to the actual
`StudioMetadataService`; it neither throws a fabricated cancellation nor returns
a successful substitute. The candidate similarly aborts the global scan signal
at the new Studio's `metadataScanner.refreshItem` entry and still calls that
original method. Native `MetadataService.SaveItemAsync` passes this token through
`LibraryManager.UpdateItemsAsync` to `ItemPersistenceService.SaveItems`, whose
`UpdateOrInsertItems` checks cancellation before the database write. Both the
validator and global dispatcher rethrow cancellation, while the scan's finally
block restarts its monitor and resets `IsScanRunning`.

The new cancellation assertions require that actual recording to show six
completed tasks, Studio task cancellation, no final database-cleanup task or
inherited-value update, the new Studio's persisted creation prefix, and retained
dead-Studio files. The orphan value is already deleted by the earlier Genre
cleanup: native `ItemPersistenceService.DeleteItem` removes all unmapped values,
independently of the later `CleanDatabaseScheduledTask`. The fresh native trace
must show that removal in the Studio creation snapshot before cancellation.
All persistent columns, relations, relevant
events, and remaining file bytes still compare against that fresh native
recording. A different actual native outcome fails with its raw receipt retained;
it is not rewritten to match the intended boundary. The candidate checks that
its sole PostgreSQL connection is reusable and no temporary tables remain, then
records runtime shutdown, schema removal, and application-root removal. The
native receipt records completed scheduler, provider, plugin, service-provider,
cache, and token disposal; the oracle must also exit successfully.
The raw native `scan-observation.json` is written before disposal so a later
shutdown failure cannot hide the already observed cancellation and SQL state.

The candidate imports only the seeded fixture entities and their pre-action value
relations from this newly recorded SQLite state into an isolated PostgreSQL
schema. It creates the same marker bytes under a fresh application root, then
executes the runtime's original `libraryScanLifecycle.run` with its original eight
task objects. The comparison covers all BaseItems columns of the fixture and
created by-name entities, all ItemValues and ItemValuesMap rows, relevant added
and removed events, real metadata refresh admission, task completion, and files.
Only the application-root relocation and newly generated timestamps are
normalized; timestamps must fall within their respective operation windows and
the Data/SQL save clocks must agree. Internal logged failures fail the test even
when the native or candidate dispatcher continues to subsequent tasks.
The music case observes the runtime's original `refreshLiveItem` as well as
`refreshItem`, forwarding both to the actual metadata host; no successful
provider or refresh substitute is installed. All success cases require complete
task execution, inherited-value cleanup, monitor restart and empty PostgreSQL
temporary-table state before the single pooled connection is reused.

The application paths/configuration and offline provider lists are explicit
harness controls. Metadata/image providers and metadata savers are empty in the
native host. Unused external video managers are absent and fail if exercised;
they are not successful cleanup substitutes. The native monitor is observational.
No movie/audio file-scanning family, image composition, network provider, watcher, general
cancellation guarantee, or complete-library-scan capability is accepted by these
narrow scenarios. The cancellation and music cases require their own Actions
evidence; source preparation alone is not a pass.

Required execution inputs are PostgreSQL, .NET 10, and the supplied current
Jellyfin assembly directory. SQLite is copied from the current SDK RID; Skia is
copied from that RID on Windows/Linux and from the universal `osx` native folder
on macOS. Missing native inputs fail before compilation. All fixture sources and
the scenario are repository inputs; no developer-machine files, historical
binary paths or historical digest substitution are used. Test execution and
compilation are reserved for GitHub Actions.
