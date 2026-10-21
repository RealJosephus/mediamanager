# Current item collections HTTP differential

`item-collections-native.test.js` records this workflow's designated native build
twice in independent stopped-instance database clones. The old sealed collection
recordings remain unchanged and do not supply expected output to this recorder.
The neutral input contains 270 BoxSets, actual manual/nonmanual links (including
the legal duplicate child at another SortOrder), unrelated parent types, users,
permissions/preferences, tags/ratings, saved user data and request parameters.

The recorder preserves the real migrated SQLite schema/history, clears only its
private copy's data, seeds real typed native objects through BaseItemMapper and
EF, and derives top-parent/rating persistence columns with the actual typed
consumers. The actual BaseItemRepository, LinkedChildrenService, LibraryManager,
CollectionManager, BoxSet/parent standalone visibility, DtoService, UserDataManager
and ItemCountService run behind real ASP.NET MVC binding/authorization/controller
HTTP. LibraryManager's read-only repository/cache/root fields are supplied by
reflection; root identities use its actual GetNewItemId and root objects are
reread from the actual repository. No query, visibility or DTO result is supplied
by a proxy. Native principal creation is controlled; IUserManager's lookup boundary
reads real EF user/permission/preference rows. This is not a native full-server
authentication or media-playback test. Metadata/provider, recording and media
execution are prohibited. Images are absent: complete empty-image DTO fields are
compared, without claiming positive native image-processor execution.
BaseItem's required PathProtocol dependency forwards only to the actual
MediaSourceManager.GetPathProtocol with actual ManagedFileSystem.IsPathFile;
every other media-source-manager operation is forbidden. This binds Path and
CanDelete's real protocol classification without opening a stream or probing.
The actual LocalizationManager.LoadAll reads its embedded rating and language
resources before any derived rating columns or visibility observations. Captures
retain the real US G/R scores and the two embedded resource byte lengths/hashes,
checked against the current designated source bindings; an uninitialized rating
dictionary cannot silently turn restricted collections into allowed unrated data.
Actual ExceptionMiddleware log exceptions are retained by case/type/message/stack
in native JSON; response status, body and all positive guards remain unchanged.

Both captures must have the complete expected request set and real successful
positive responses; an unbound dependency's 500 cannot become a matching oracle.
The first controlled stopped database is imported by production transferDatabase
into fresh PostgreSQL, then production createRuntime and real authentication/API
keys serve the same HTTP requests. Complete JSON values, status, MIME, Allow and
non-JSON bodies are compared. Only actual trace IDs and equivalent date spelling
(preserving all 100ns ticks) are projected. Unknown fields and nullable/bad/repeated
bindings are sent to actual MVC before their results are compared.

Coverage includes manual reverse DISTINCT/type filtering, hidden/missing target,
selected/blocked library access, parental/tag policies (including a modern G
collection whose standalone override bypasses an R-rated ordinary parent), cached
membership in a visible nonfolder Movie child of UserRoot (that GetChildren
consumer has no OfType<Folder> restriction), OrdinalIgnoreCase SortName/Name with
Unicode and equal keys, complete visible count before paging, explicit persisted
ForcedSortName input and actual cold-mapper same-SortName/different-Name
assertions (the mapper resets its SortName cache),
negative Skip/Take, zero/out-of-range windows, default/selected/unused ItemFields,
user data, the UserRootFolder target exception, and retained objects' unsaved
Name/SortName, OfficialRating, CustomRating and LibraryFolderIds (nonempty to
empty, including the empty-cache bypass). Native GetBaseItemDtos
performs its own post-page visibility pass; count is not recomputed and pages are
not replenished. PostgreSQL candidate and result reads must remain bounded to
128 while considering all 270 candidates, including more than a page of hidden
collections. The last lane holds a real SQL relation query during library/runtime
close and proves rejected new admission, successful old HTTP completion, owner
drain and database/server closure. Gates are always released before cleanup waits.

Every native table and controlled state file is snapshotted before/after reads
on its own backend. Node's password/device/key and runtime initialization occur
before that baseline; they are not claimed to be read-only or identical to native
principal setup. The native principal is controlled; Node still runs real token
authentication with its existing clock dependency fixed to one actual sample
before login. This isolates the authentication layer's three-minute device
activity update from library reads during the long matrix. Devices and every
column remain in the complete unchanged-table assertion. HTTP deadlines and
monotonic SQL timings keep their real clocks. The complete fixture has a
twenty-minute outer test budget for two independent native builds/captures,
all 105 production HTTP requests and shutdown verification; each HTTP request
still has its original thirty-second deadline. The raw Node before/after/after-shutdown file lists remain in
the report. The one diagnostic `plugins/node/host.lock` is read from the actual
PluginHost directory, bound to the current process PID, a real UUIDv4 nonce,
byte length and SHA-256, and reread with exact byte/identity assertions before
shutdown. Real runtime close must remove that exact file, verified with ENOENT.
Only the post-shutdown persistent-file comparison projects out this proved
transient filename; it excludes no directory or filename pattern. The live
before/after comparison still includes the complete lock bytes/hash identity.
The actual application paths are shared across captures and PG
so full DTO Path values are compared directly. No private SQLite clone is kept in
the uploaded evidence tree: strict path/link-checked cleanup removes the external
owned temporary root after processes and runtime exit, on success or failure.
Receipts, source/runtime/RID hashes, complete HTTP JSON, SQL observations, table
digests and cleanup evidence remain. `phaseAcceptance` covers this API slice only;
`releaseAcceptance` stays false. Business verification runs in Actions only.
