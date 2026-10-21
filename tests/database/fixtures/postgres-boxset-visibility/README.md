# BoxSet SQL visibility projections

`tests/database/postgres-boxset-visibility.test.js` executes the real PostgreSQL
query builder and checks stored and temporary typed visibility values. Its source
bindings are `BoxSet.IsVisible`, `BoxSet.GetLibraryFolderIds(User)`,
`BaseItem.IsParentalAllowed`, `LocalizationManager.GetSingleRatingScore`, and
`Folder.GetChildren` in the designated Jellyfin
source. The independent current item-collections HTTP recorder executes those
actual native consumers; this SQL test does not claim to execute a native DLL.

`LibraryFolderIds = null` derives membership from linked descendants. An explicit
empty array skips membership and child parental checks after the collection's
own parental check succeeds. A nonempty array intersects the actual visible
user-root child identities, including a non-folder child when present. Physical
top-parent IDs are a separate input.

For null membership SQL follows each linked non-BoxSet's actual ParentId chain,
stops before an Aggregate parent, and follows OwnerId only when no parent exists.
It compares the terminal Path to raw user-root folder Paths/PhysicalLocations by
OrdinalIgnoreCase after the actual virtual path expansion. Conflicting persisted
TopParentId cannot decide membership.
`boxSetRootFolders` is the complete raw folder navigation input, with exactly
`Id`, nullable `Path`, and nullable `PhysicalLocations` (nullable string entries).
It has no candidate-page limit; candidate typed projections remain capped at
128. Root folder matches are aggregated in SQL before visible user IDs intersect.
An inaccessible raw folder's null source is still consumed. The dedicated pure
SQL matcher preserves nullable Path equality before the source-null error; its
unique error state maps to the native ArgumentNullException/source 400.
An earlier matching raw folder cannot hide a later mismatching folder whose
PhysicalLocations is null. Own parental denial, no links, and explicit empty
membership retain their earlier short circuits.

The internal `visibility.boxSetRootLookupOnly: true` query mode is accepted only
with `boxSetStandalone: true`. It returns only BoxSets which pass their own
parental checks, have raw links and have a complete nonempty stored/live/derived
membership. It reuses the same membership expression and raw-folder error order.
This preflight does not consume `boxSetUserRootIds`, which may be omitted, and
does not run the child parental checks that follow native root access. A caller
uses these rows to decide whether to prepare the real root navigation frame,
then runs the normal full visibility query. False or omitted keeps the existing
full contract, including mandatory observed root identities. The test retains
own-denied, no-link, typed-empty, derived-empty, child-denied, explicit-null and
late-null-source controls for the two distinct query purposes.

`boxSetPathExpansion` has exactly the two string fields `appDataPath` and
`metadataPath`, obtained from the actual expander applied to `%AppDataPath%`
and `%MetadataPath%`. When the caller has no expander, those tokens are identity
replacements. SQL expands all Data tokens before all Metadata tokens, including
Metadata tokens inside the earlier Data replacement. Paths cross the navigation
boundary as canonical OrdinalIgnoreCase UTF-16BE hex, preserving NUL, literal SOH,
isolated surrogate units and pairs without putting raw strings in jsonb. The
persisted path's existing SQL OrdinalIgnoreCase key uses the same representation.
Replacement scans only aligned two-byte units; it cannot match across adjacent
units. This fixes the BoxSet membership path and does not claim to fix the
independent existing parental-rating country path expansion.

`nativeVisibilityProjections` contains at most 128 complete entries with `Id`,
nullable `OfficialRating`, nullable `CustomRating`, and nullable `LibraryFolderIds`.
Identity is canonical and unique. A SQL presence check preserves explicit null;
it must not fall back to stored values. The bounded input relation affects only
visibility expressions and never writes or mirrors the BaseItems relation.
These four fields do not claim to represent every possible unsaved entity field.
Stored GUID arrays use the existing native JSON Guid reader for N, D, B, P and X
spellings; user-root identities are a separate typed input.
The test binds `JsonGuidConverter.ReadInternal`, whose actual source calls
`Guid.Parse`. Each spelling is checked individually by the real SQL reader and
the stored-array query before the combined five-format query. An X spelling
missing its outer closing brace remains a hard `MM001` rejection. The earlier
39677899083 failure supplied exactly that malformed fixture spelling; its raw
failure remains evidence of that candidate, not a parser pass.

The report retains the source scope, SQL plan digests, complete case outcomes,
unchanged persisted values, and a 131-result count split into 128/3-row pages.
It also checks Data/Metadata ordering, repeated tokens, a token's byte pattern
across an odd boundary, and nullable/span string comparisons in the real SQL
functions. Raw user-root linked-child resolution belongs to its production
consumer and is not claimed as complete by this module.
Verification runs in Actions only. Release acceptance stays false.
