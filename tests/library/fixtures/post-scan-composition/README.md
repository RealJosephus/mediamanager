# Nonempty eight-task composition

This fixture is source preparation for an Actions differential, not a recorded
pass or release admission. The test builds and executes `Oracle.csproj` against
the Jellyfin runtime supplied by the same CI run. It retains fresh `record.json`,
build/process logs, raw `native.json`, the native SQLite databases and a candidate
receipt below `MEDIAMANAGER_VALIDATION_OUTPUT_ROOT`.

`NativeScanHost.cs` derives from the actual eight-service host recorded in
`post-scan-composition-native-1` on 2026-10-16. The previous empty/ordinary
recordings are not inputs or expectations for this test. This new source fixes
the by-name application paths to their real singular names, installs the actual
Genre and Studio metadata services, and replaces the former unused external
deletion seam with the real `ExternalDataManager` and `PathManager`.

The single scenario saves a detached ordinary Folder with one Genre and one
Studio through native `ItemPersistenceService`. It also saves two unreferenced
by-name items, writes source/internal/extracted marker files, and inserts an
unmapped ItemValue. An empty-root global scan must then create both live by-name
items, refresh them, delete both dead items and their files, and remove the orphan
value. All eight actual post-scan exports remain registered in their discovered
order and are dispatched by `LibraryManager.ValidateMediaLibraryInternal`.

The candidate imports only the three fixture entities and their pre-action value
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

The application paths/configuration and offline provider lists are explicit
harness controls. Metadata/image providers and metadata savers are empty in the
native host. Unused external video managers are absent and fail if exercised;
they are not successful cleanup substitutes. The native monitor is observational.
No movie/audio family, image composition, network provider, watcher, cancellation,
or complete-library-scan capability is accepted by this narrow scenario.

Required execution inputs are PostgreSQL, .NET 10, and the supplied current
Jellyfin assembly directory. SQLite is copied from the current SDK RID; Skia is
copied from that RID on Windows/Linux and from the universal `osx` native folder
on macOS. Missing native inputs fail before compilation. All fixture sources and
the scenario are repository inputs; no developer-machine files, historical
binary paths or historical digest substitution are used. Test execution and
compilation are reserved for GitHub Actions.
