# Channel and Live TV visibility

`channel-visibility.test.js` writes the input manifest, then uses the workflow's
designated current native build and stopped instance. The oracle copies that
SQLite file into its private output, keeps schema/migration history unchanged,
and replaces only the private library graph. It never starts recording, tuner,
transcoding or network execution.

Actual repository-hydrated `BaseItem`, `Channel`, `LiveTvChannel` and
`LiveTvProgram` execute `IsVisible` and `IsVisibleStandalone`. Actual
`ChannelManager.GetChannel` uses actual `LibraryManager.GetItemById`; it is a
single lookup followed by `Channel.IsVisible`, including empty, missing and
wrong-type references. XML supplies default enabled library options. No rated
items are supplied, so the controlled localization service does not replace a
rating calculation. Tag inheritance and unrated categories execute natively.

The actual EF selector executes the recording ancestor/media/virtual predicate,
user parental filtering, ordering, count and page on more than 128 rows. Its
post-page `IsVisible` IDs are compared separately from repository IDs/count.
The same stopped SQLite rows are loaded into a fresh PostgreSQL schema and
consumed by the production library reader and recording selector/DTO projection.
No channel restriction is silently added to the repository query: native
`Channel.IsVisible` and repository access filtering are distinct operations.

The receipt retains input/build/assembly/packaged SQLite hashes and source
bindings, all component observations, full SQL-selected IDs/counts and cleanup.
This proves component and PostgreSQL read contracts. HTTP authorization and
wire errors remain covered by the separate real recordings HTTP fixture; no
playback or final release acceptance is claimed.
