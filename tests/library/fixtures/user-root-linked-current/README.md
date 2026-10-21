# Current UserRoot linked navigation

This independent fixture runs the supplied designated native build twice over
two real stopped SQLite clones. It uses the actual repository/mapper,
LinkedChildrenService, UserRoot.GetChildren, LibraryManager.GetCollectionFolders,
CollectionManager, UserViewManager and DtoService.GetBaseItemDtos. The read-only LibraryManager dependency
boundary is assembled as in item-collections-current; native root initialization,
HTTP hosting, authentication filters and media execution are outside this scope.
Actual EF users/permissions/preferences supply user policy. The original migrated
schema/history and foreign keys are retained; EnsureCreated is not used.
The seeded Aggregate has the IsRoot=true assigned by the actual generic root
resolver. The actual MediaSourceManager protocol parser is supplied with its
actual ManagedFileSystem; the narrow boundary rejects all other manager methods.
Actual LocalizationManager.LoadAll precedes derived rating columns and all
visibility reads. Native captures retain the actual US G/R scores and embedded
US rating/language resource byte hashes, compared with current source bindings;
the component cannot pass with an empty uninitialized rating dictionary.

The plain-root DTO lane passes actual `UserRoot.GetChildren(user,true)` directly
to actual `DtoService.GetBaseItemDtos` with `skipVisibilityCheck=true`, matching
the ItemsController plain-root consumer. Its explicit fields are Overview,
Genres, Tags, Taglines and ProviderIds; images and user data are disabled. The
complete DTO array is serialized with actual JsonDefaults.Options, including
ordinary fields, generated GenreItems identities, empty collections and omitted
null values. The Node side uses formal LibraryService.queryItems with the
actual UserRoot parent, then consumes its normal public JSON serializer; it
does not call a fixture DTO projector or replace the result with scalar root
projections. Both independent native captures must agree before this output
becomes the PostgreSQL comparison input.

DTO genre IDs use the real LibraryManager/Genre identity methods and the actual
ServerApplicationPaths Genre/MusicGenre layout. Actual RecordingsManager is
constructed solely to supply its real empty-active-dictionary read branch to
DtoService and Video.SourceType. Its constructor initializes the dictionary and
subscribes to the controlled configuration event; this fixture never raises
that event, initializes timers, supplies a media encoder/stream helper, or calls
recording/media execution methods. The dictionary must remain empty before and
after every case set; normal Dispose releases the unused semaphore. Provider
and monitor dependencies continue to throw on any attempted execution. Chapters,
Trickplay, MediaSources, ExternalUrls and image processing are not requested.

The first native stopped controlled database is transferred through the
production database-transfer path into fresh PostgreSQL, then opened by the real
createRuntime. Formal LibraryService.loadNavigation and rootChildren consume
the owned frame. GetCollectionFolders and public getItemCollections remain
separate consumers. UserViewService.views uses its normal typed-folder menu
branch, including a linked by-name MusicArtist with IsFolder=false. Ordinary
Movie root children remain eligible for BoxSet membership and stay out of menus.

The neutral input has 140 positive links with all four native link types and
three direct root children. It covers complete bounded positive batches, per-user
rating/tag/library differences, raw/virtual/linked order and duplicate object
identity, repository-positive precedence over registered warm values, explicit
empty/null/replaced handles, Path-before-LibraryItemId fallback, cached Guid.Empty,
read-after-resolution, own-G/parent-R IsVisible, raw-only folder membership,
typed menu membership, and public BoxSet access before/after link replacement.
Native ConcurrentBag virtual children use their actual single-thread enumeration;
the neutral virtual list specifies that enumeration order. Warm Children and
links are explicit typed inputs, never candidate-generated repository results.
Five DTO observations additionally retain 140 positive links across bounded SQL
hydration, independent direct/virtual unsaved media metadata, first Guid position
with last passing virtual value (including null Overview and empty Taglines),
positive repository replacement of same-Guid warm occurrences, and rejection of
a registered same-Guid warm metadata value as a positive-batch substitute. The
original root/raw/BoxSet/menu observations and final held membership lane remain.

All successful scalar projections, complete DTO JSON and raw link values are compared completely.
Component failures compare actual exception type and status; full raw messages
and stacks are retained without claiming HTTP error-wire parity. There is no
deliberately malformed late positive-ID mapper failure in this first slice, so
its successful batch evidence does not establish every possible failure prefix.
Original item-collections-current's 270-item HTTP baseline is unchanged.

Every SQL resolution read is limited to 128. A real positive-batch SELECT is held
inside public getItemCollections while library/runtime close reject new public
admission and drain the original query and state/cohort owners. The gate is
released in finally before awaiting pending operations. All persisted native/PG
tables and owned state-file bytes are compared before/after and after independent
PG reopen. Complete raw before/after file maps remain in the report. Only the
exact `plugins/node/host.lock` is excluded from the post-shutdown persistent
comparison: actual PluginHost source, PID, UUID nonce and full bytes/hash are
bound while open and rechecked before shutdown; real runtime close must remove
that exact path (lstat ENOENT). No other file or lock is excluded, and ordinary
read-before/read-after maps still compare that file completely. Actual loaded
assemblies/RID SQLite are rehashed against supplied
runtime bytes, as are input/source bytes. Private database clones stay outside
uploaded output and are removed on success/failure with resolved path/no-link
checks; raw JSON, build/process receipts and cleanup results remain artifacts.

Only Actions executes this fixture. Native capture alone, this component slice,
and its controlled size do not establish full product or release acceptance.
