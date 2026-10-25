# Native AudioBook and Book edits

Ten controls run the actual pinned ItemUpdateController.UpdateItem and DTO converters on concrete AudioBook and Book entities. Library save, people and refresh callbacks are controlled. The projection covers Artists, AlbumArtists, Album and the null-name exception. The oracle does not run EF, NFO or HTTP; candidateVerified remains false.

The candidate compares the controller field projection through the actual request binder and update implementation. Twenty additional actual HTTP controls run SQLite and real PostgreSQL, checking persisted artist fields/maps, Data NULL policy, update events and an unchanged database after the null-name failure. Local metadata saving is disabled for these controls. These tests do not claim full native persisted rows, sidecars or complete book/audio refresh.
