# Native TV BeforeSave recording

`Program.cs` invokes the pinned `EpisodeMetadataService` and
`SeasonMetadataService.BeforeSaveInternal` methods on 26 explicit inputs.
The actual entity getters resolve physical parent chains and typed cached
Series/Season references. The library item lookup and options are controlled
callbacks; filesystem metadata reports missing.

The recording fixes `isFullRefresh=false` and `currentUpdateType=None`, so
child aggregation, virtual-season status, BeforeMetadataRefresh, providers,
repository writes, images and AfterMetadataRefresh are outside its boundary.
It covers parent correction order, missing/wrong-type/external cached IDs,
flat and nested physical parents, range ends, special names and locks.

`tv-before-save.test.js` consumes the same input and compares actual candidate
SQLite/PostgreSQL context, update flags and persisted fields. It separately
tests current provider lookup, first-save cancellation, stale query ancestors,
and corrected series sidecar paths; these candidate integration cases do not
extend the native oracle boundary.

`provenance.json` seals the raw source, project, build properties, input and
native output.
The oracle retains `candidateVerified:false`.
