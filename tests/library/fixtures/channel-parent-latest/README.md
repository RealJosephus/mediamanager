# Channel parent Latest

This current Actions consumer executes the designated Native
`UserLibraryController.GetLatestMedia`, `UserViewManager.GetLatestItems` and
`ChannelManager` against real EF SQLite persistence and its real DTO service.
The Node side installs the declared provider through PluginHost, executes the
actual `/Items/Latest?parentId=...` route and selects/groups through PostgreSQL.
Provider responses and metadata execution are controlled at the same boundaries
as the separate Channel Items fixture. The original Channel fixtures are unchanged.

The matrix covers actual root/one-folder refresh and cache reuse, ordered Audio
and Episode container groups, single-track MusicAlbum output, single-Episode
leaf output, ChildCount, grouped and ungrouped limits including zero/negative,
IncludeItemTypes, HidePlayedInLatest and explicit IsPlayed, inherited blocked
tags/channel permissions, allowed-tag leaves grouped into a container without a
second visibility filter, Trailer
ordering, missing Latest capability and an absent provider with retained rows.
Ordinary Channel Items and Channel Latest service queries also exercise the
IncludeItemTypes mapping against the real Native ChannelManager.

Candidate filtering, ordering, paging, presentation grouping and latest-container
grouping stay in SQL. Comparisons use full public results, provider reads and
persisted item/user values. Queue traces and exception type/stack remain raw
diagnostics. Cache table layouts, object references and SQL text are not gates.

Each run retains exact input bytes, a new Native output, source/build receipts,
original process logs, candidate HTTP responses, comparison observations and
cleanup records. `current-profile.json` binds the scenario producer and current
oracle/build sources; it does not depend on a historical recording.
This is a controlled provider consumer test, not Native MVC
binding, actual remote provider, media execution, complete instance migration or
release acceptance.
