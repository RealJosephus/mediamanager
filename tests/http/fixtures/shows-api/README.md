# Shows API native oracle

This fixture executes the pinned Jellyfin `TvShowsController` and the shared
`LibraryController.GetSimilarItems` action from commit
`208c278b75abd897aefa1e1175126eac5e4dbfaa`. Its 42 controller scenarios call
the real Upcoming, Episodes, NextUp, Seasons and shared Similar methods. Episodes and Seasons
also execute the real `Series`/`Season` query construction, missing-item
policy, adjacency handling and native TV comparers. NextUp records the exact
controller-to-manager query boundary, including required-user resolution,
defaults, DTO options, negative paging and date cutoff.

Similar reflection seals every route alias, `[Authorize]`, parameter source,
`[Required]` and collection binder. Real ASP.NET simple/collection binders
freeze missing, empty, invalid and `Guid.Empty` route IDs plus single and
repeated comma-delimited `ExcludeArtistIds`/`Fields`. Real controller calls
freeze claim/user selection, cross-user rejection, missing-item ordering,
user and aggregate roots for `Guid.Empty`, Episode/IItemByName early empty
results, the MusicArtist exception, manager arguments and DTO projection.
The actual `SeriesSimilarItemsProvider`, `MusicArtistSimilarItemsProvider`,
`MusicAlbumSimilarItemsProvider` and `AudioSimilarItemsProvider` captures fix
their official internal query defaults: type-specific inclusion, genre/tag
filters, random order, source excludes, `ParentId=Guid.Empty`, non-recursive,
null search, presentation grouping and enabled total counting. The three music
providers additionally preserve `ExcludeArtistIds`; Series does not.

The fixture separately executes the pinned `TVSeriesManager` with native
comparers and controlled library/user-data seams. This freezes parent and
series scoping, key discovery, the valid-empty-series-key limit of eleven,
resumable/rewatching behavior, total-count suppression, negative paging and
the empty-key internal start-index reset. A separate empty-result controller
case proves that the public response nevertheless preserves the requested
start index. The concrete `BaseItemRepository` over EF Core SQLite establishes
userless versus user-scoped presentation-key grouping and negative paging. Its
concrete `LibraryManager`/`NextUpService` probes establish empty-parent ancestor
sentinel behavior, live-TV and non-groupable UserView parent translation, key
discovery, cutoff filtering, watched-successor selection, specials and
rewatching. Real controller calls backed by concrete `LibraryManager` and the
real `ExceptionMiddleware` freeze Guid.Empty as `400 text/plain` for NextUp
parents and Seasons series. The real ASP.NET `DateTimeModelBinder` freezes
blank, wall-clock, UTC, offset and invalid cutoff binding.
The season repository probe also freezes predicate-before-grouping behavior
when duplicate presentation-key rows disagree on persisted missing state.
The similarity repository probe freezes OR within source genres/tags, AND
between the two dimensions, userless rows versus user presentation-key
grouping, top-parent access filtering, representative selection and the
pre-page total. The real `SimilarItemsManager`, controlled only at its local
provider seam, freezes default limit 50, unconditional `ProviderIds`, source
ID and presentation-key exclusion, ID/key deduplication, zero/negative early
stop, limit-before-final-access without refill and concrete repository access.

The executable also runs that manager with ordered local and remote providers
plus the real `TmdbSeriesSimilarProvider` and TMDbLib client over a controlled
`HttpMessageHandler` (never the public network). It freezes case-insensitive
provider enablement/order, stable registration ties, remaining limits and
excludes, exception continuation, cancellation stop, 20-reference resolution
batches, the 500-reference cap and early stop after a resolving batch. Remote
scenarios cover valid source IDs whose references do not resolve locally,
null responses, transport exceptions, 429 retry and 500 responses. Real cache
IO freezes the lowercase key/path, compact PascalCase UTF-8 JSON without a BOM
or null `Score`, future-hit versus expired/corrupt fallback, the configured
expiry window and overwrite-without-leftover-temp behavior. Scored cache probes
freeze `AllowReadingFromString` numeric-string ordering, exact decimal-to-Single
rounding across the `0.5000000298023224` binary64 double-rounding boundary, and
whole-cache fallback for an invalid string and a quoted value outside the
finite `Single` range. Reflected score bits and a real scored remote provider
freeze every float32 multiply/subtract/boost/add/clamp boundary and stable order
when `0.1f` and `0.100000001f` are the same `Single`. The candidate additionally
rejects named `NaN`/infinity strings and any non-finite score as a stricter
fail-closed cache policy; that safety rule is explicitly not claimed as native
`JsonDefaults` parity.

For the controller scenarios, `GetItemById`, selected repository result arrays,
user lookup, the NextUp manager result and DTO object creation are small
explicit `DispatchProxy` controls. The capture records every native query and
DTO option passed across those seams. `LibraryManager.GetItemList` parent
translation is not faked as controller behavior: it is established by sealed
pinned source, concrete probes and candidate SQLite/PostgreSQL tests covering
Guid.Empty, missing IDs, CollectionFolder, grouped/live-TV/non-groupable
UserView, Series and non-folder ancestors.
ASP.NET authorization-filter execution, concrete `DtoService` internals, live
external services and deterministic Random order remain outside the native executable.
Attribute/binder contracts and candidate HTTP authorization are covered. A
proves that missing or invalid `MusicBrainzArtist` IDs make no request, while a
  valid Guid starts HTTP enumeration. The candidate keeps local results for
  valid ID, preserving the recorded URL, score order, cache duration and
  PostgreSQL-bounded reference resolution. This fixture seals Series TMDB and
  Controlled transport evidence is not a public-network acceptance claim.

The sealed Series, MusicArtist, MusicAlbum and Audio local Genre/Tag providers
are implemented through the native Artists, Items, Albums and Shows aliases.
Movie/Trailer weighted Similar, LiveTvProgram query branches and TMDB Movie
now use the independent native oracle in `tests/library/fixtures/movie-similar`.
This HTTP suite integrates those providers through PostgreSQL, including the
manager's caught userless movie failure, remote resolution and cache hits.
Movies and Trailers retain their declared shared-action aliases. Zero and
negative limits retain the native empty result without invoking providers.
Unsupported DTO fields are still rejected before that manager early stop.
The candidate HTTP matrix persists an exact pinned
`MediaBrowser.Controller.LiveTv.LiveTvProgram` row in PostgreSQL and verifies
movie-first, series and unmapped-Program empty branches through the userless
API-key path, without claiming the complete live-TV user-access policy.
The same pinned source also seals the loader's internal
`LiveTvProgram` kind, `LiveTV` source, virtual/non-folder and media/unrated
traits; direct production projection verifies its public DTO type is
`Program` and omits the native LiveTvProgram-specific `LocationType`.

The reference assemblies were built from an independent clean clone, not the
`D:/jellyfin` working tree. Recreate it and verify the pinned checkout before
recording:

```powershell
git clone --no-hardlinks D:/jellyfin D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source
git -C D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source checkout --detach 208c278b75abd897aefa1e1175126eac5e4dbfaa
git -C D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source status --short
D:/mediamanager/.tools/dotnet/dotnet.exe build D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source/Jellyfin.Server/Jellyfin.Server.csproj -c Release
```

Every one of the 55 source entries in `provenance.json` is the raw byte output
of `git show 208c278b75abd897aefa1e1175126eac5e4dbfaa:<path>` and is checked
against that commit independently of the clone's working files.

The isolated recording command was:

```powershell
$env:MEDIAMANAGER_DOTNET='.tools/dotnet/dotnet.exe'
$env:MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY='D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source/Jellyfin.Server/bin/Release/net10.0'
$env:MEDIAMANAGER_JELLYFIN_DLL='D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'
node tools/validation/oracle.js tests/http/fixtures/shows-api/Oracle.csproj .test-output/validation/shows-api-oracle-20261008-v18-pinned tests/http/fixtures/shows-api/input.json '{output}/native.raw.json'
```

The recorder's raw native output uses CRLF and has no final newline. The tracked
`native.json` is the same JSON normalized to LF with a final LF; provenance
keeps and the seal test reconstructs both byte identities.

`provenance.json` seals the input, native output, executable oracle, project,
shared build properties, pinned controller/entity/TV and similarity
manager/provider/model-binder/repository sources and the complete managed
assembly set loaded by the executable plus its loaded SQLite native artifact.
That runtime list is emitted by the oracle itself and must exactly match the
provenance copy.
`native.json` deliberately remains `candidateVerified: false`; candidate parity
is established by `tests/http/shows-api.test.js` against the PostgreSQL runtime;
SQLite is used only by the native oracle and database exchange tests.
