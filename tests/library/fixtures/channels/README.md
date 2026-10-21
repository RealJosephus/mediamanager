# Installed external Channels

The fixture calls the supplied assemblies' actual `ChannelManager`,
`ChannelsController`, `DtoService`, `UserViewManager`,
`ChannelImageProvider`, `BaseItemMapper`, `LibraryManager.GetNewItemId`,
`LibraryManager.Sort` and `SortNameComparer`. It loads the actual embedded
localization data and uses the actual image tag/dimension reader. Every run
records the input digest, source bindings and loaded assembly digests.

`ChannelManager` is constructed normally. Its library lookups, repository ID
selection, creation persistence, user lookup and user-data lookup are explicit
controlled boundaries. The ID selector checks the actual requested repository
type/order. This component does not open native EF/SQLite or claim a native
database query differential. Native manager filtering, count, paging, provider
selection, typed visibility, feature construction, default DTO evaluation and
Views ordering execute unchanged. The metadata refresh callback records the
actual `BaseItem.RefreshMetadata` dispatch; the complete native metadata engine
is not replaced by a copied refresh loop. Images separately execute the actual
`ChannelImageProvider` monitor and callbacks with owned PNG streams and exact
disposal counts. No media, recording, packet-copy or encoding executor runs.

The full default DTO keeps its real chapter and path-protocol evaluation. The
actual `ChapterManager` reads a controlled empty, read-only chapter repository;
the actual `MediaSourceManager.GetPathProtocol` uses the actual managed
filesystem. The user root and physical `AggregateFolder` are explicitly empty,
including the latter's virtual children. Both consumers explicitly enable the
native default `EnableCaseSensitiveItemIds`; the native receipt records this
input so display-marker identity cannot silently use different case policies.
The input document preserves explicit null members, including the invalid
feature-collection case; response omission rules are not applied to fixture input.
The controlled repository selector preserves the actual SortName-then-Name
ordering. Observed default user data for roots created during native reads is
not seeded before those roots exist on Node. Explicit null feature lists retain
the actual `List<T>.ToArray()` NullReferenceException, and Channel-source DTOs
retain the native omission of ChildCount even when that field is selected.

The first empty-inventory scenario additionally starts a private Kestrel host
with the actual Channels controller, MVC binders, default authorization handler
and exception middleware. Principal authentication and user/network lookups
are controlled. The host executes the request matrix and then stops/disposes.
It verifies aggregate invalid query binding, anonymous precedence, regular
cross-user rejection, API-key/userless reads, empty GUID fallback, ignored
unbound fields and Features route binding/errors. Exception diagnostics remain
alongside each exact request and wire response.

The Node consumer uses a fresh real PostgreSQL schema, the actual DomainStore,
bounded typed entity/cache/cohort machinery, ItemCreationService,
MetadataRefreshHost, mapped Local storage and the real PluginHost/SDK activation
path. Creation and refresh use the production services; they are not stubbed.
The HTTP side uses the real application/routes and authorization policy.
All catalog scope, capability decisions, user visibility, favorite selection,
stable order, count and page selection stay in PostgreSQL. Only final items or
at most 128 typed slots/relations hydrate together. The 129-provider scenario
crosses that boundary. Scope tables, typed states, contexts and linked handles
must be released on success/failure before owner closure.

An installed inventory is distinct from retained `Channel` rows: an orphan is
absent from catalog/Views but still fails the all-Features reader at the real
provider lookup. Existing roots retain their fields. Missing roots are created
before capability/enablement filtering. Unsaved warm Name and ImageInfos edits
exercise actual cached entity consumers while PostgreSQL retains the old name
and zero image rows. Culture-equal provider names preserve registration order;
catalog SortName ordering and Views ordering are separate native consumers.

Display uses registration order and the referent's own identity, unlike the
name fallback used by Features. The cases preserve the empty-inventory missing
referent short circuit, nonempty missing referent failure, empty-ID exception,
marker behavior and duplicate-identity first choice. The image provider compares
supported types, missing-image monitoring, exact owned PNG bytes and callback
order; ordinary Channel internal metadata paths use their actual override.

The catalog advertises the actual latest/deletion interface markers. This
fixture deliberately does not invoke their business execution paths, fetch
external item catalogs, run scheduled Channel refresh or delete provider media.
Their execution consumers require separate implementation and evidence.
Component comparison is not final release acceptance.
