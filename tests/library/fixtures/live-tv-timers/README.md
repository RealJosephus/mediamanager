# Saved timer reader and DTO component differential

`Program.cs` executes the selected build's actual `LiveTvManager`, `DefaultLiveTvService` readers, `ItemDataProvider`, and `LiveTvDtoService`. Timer managers are constructed without calling `RestartTimers`; no recording executor, stream, tuner, or encoder is started. Private timer documents are removed before output publication.

Program `BaseItemDto` construction and image repository lookup are controlled inputs. The oracle publishes the exact typed program DTO input so the Node callback receives the same value; this does not validate the generic program DTO builder or image repository. Real PostgreSQL supplies the Node saved-state authority, all filtering, invariant numeric name ordering, stable tie order, counts, pages, and requested identity matching. HTTP authorization, native EF queries, actual image winner selection, and full runtime startup are separate consumer scopes.

The differential covers saved fields/defaults, 100 ns values and DateTime Kind formatting, status filtering, channel and series identities, null entries/days and complete series-detail evaluation, negative durations/padding, initial program association plus timer overrides, defaults, read-only PostgreSQL state, source-file independence, and a result spanning multiple bounded pages.

Sources are `D:/jellyfin/src/Jellyfin.LiveTv/{LiveTvManager,LiveTvDtoService,DefaultLiveTvService}.cs`, `D:/jellyfin/src/Jellyfin.LiveTv/Timers/`, and the corresponding `MediaBrowser.Controller/LiveTv`/`MediaBrowser.Model/LiveTv` model files, under the project GPL license. Run only in the authorized CI workflow.
