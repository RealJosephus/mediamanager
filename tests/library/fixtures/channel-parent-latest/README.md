# Channel parent Latest

This current Actions consumer executes the designated Native
`UserLibraryController.GetLatestMedia`, `UserViewManager.GetLatestItems` and
`ChannelManager` against real EF SQLite persistence and its real DTO service.
The Node side installs the declared provider through PluginHost, executes the
actual `/Items/Latest?parentId=...` route and selects/groups through PostgreSQL.
Provider responses and metadata execution are controlled at the same boundaries
as the separate Channel Items fixture. The original Channel fixtures are unchanged.

The original 32 steps cover actual root/one-folder refresh and cache reuse,
Audio album grouping, Episode leaf output before metadata completion,
ChildCount, grouped and ungrouped limits including zero/negative,
IncludeItemTypes, HidePlayedInLatest and explicit IsPlayed, inherited blocked
tags and explicit channel-parent selection, allowed-tag leaves, Trailer
ordering, missing Latest capability and an absent provider with retained rows.
Ordinary Channel Items and Channel Latest service queries also exercise the
IncludeItemTypes mapping against the real Native ChannelManager.

ChannelManager persists the declared MusicAlbum and Series types. A channel
album is exposed as `ChannelFolderItem` by the public DTO contract, including
when one audio candidate returns its album. The original controlled metadata
boundary leaves presentation identities unpopulated, so repository grouping
can select one Episode before container grouping. That case retains the leaf;
it does not establish that a Series parent is absent.

A further 13 steps start from six actual Native persisted MusicAlbum, Series,
Audio and Episode items with distinct presentation identities. Native creates
them through LibraryManager and reads their SQLite item and ancestor rows;
Node imports those rows into PostgreSQL before installing the same provider. Both sides then
refresh and execute Latest. These steps cover one/two-track album counts,
one-Episode leaf versus two-Episode Series output, ungrouped leaves, inherited
blocked tags, allowed-tag grouping without a second visibility filter, and
played/unplayed leaf selection. Presentation identity values are included in
the persisted comparison.

Candidate filtering, ordering, paging, presentation grouping and latest-container
grouping stay in SQL. Comparisons use full public results, provider reads and
persisted item/user values. Full provider/cache-key calls, cancellation-token
properties, queue traces and exception type/stack remain raw diagnostics; the
provider comparison uses the actual item-read requests. Cache table layouts,
object references and SQL text are not gates.

Each run retains exact input bytes, a new Native output, source/build receipts,
original process logs, candidate HTTP responses, comparison observations and
cleanup records. `current-profile.json` binds the scenario producer and current
oracle/build sources; it does not depend on a historical recording.
This is a controlled provider consumer test, not Native MVC
binding, actual remote provider, media execution, complete instance migration or
release acceptance.
