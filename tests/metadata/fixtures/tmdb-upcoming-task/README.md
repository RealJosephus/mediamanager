# TMDB upcoming scheduled-task oracle

`Oracle.cs` binds the scheduled task contract to the actual
`MediaBrowser.Providers.Plugins.Tmdb.TV.TmdbUpcomingEpisodesTask` in the pinned
Jellyfin build. It records identity/text/default triggers plus the null-config,
globally disabled cleanup, and enabled/no-Series execution branches.

The controlled `ILibraryManager` records the real task's query and deletion
requests. It does not claim active `Series.ValidateChildren`, database/files,
events, or live TMDB transport; those are covered separately by candidate
SQLite/PostgreSQL runtime tests or remain an online boundary.
