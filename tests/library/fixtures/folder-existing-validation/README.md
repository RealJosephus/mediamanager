# Native existing matching-child validation

These 43 scenarios invoke the actual protected
`Folder.ValidateChildrenInternal` method from the frozen Jellyfin assemblies,
with recursion and child metadata refresh disabled. Setup first runs genuine
warm CreateItems, retrieves its live item, applies the input mutation, and seeds
it through the real EF SQLite persistence service before the measured validation.

The recording covers ordinary Movie, MusicVideo, Video and Folder matches:
unchanged items, mixed state, AdditionalParts and LocalAlternateVersions arrays,
VideoType, file-stack order, new siblings, AggregateFolder ancestry, and metadata
preservation including an unsafe CLR Int64 runtime. Local images cover current,
outdated and missing files, dimension and BlurHash failures, image insertion
failure, image persistence before a failed item update, and image work that
ignores the scan cancellation token.

Comparisons preserve all 72 BaseItems columns, complete typed Data, ordinary
relationships and image rows, created lookup, dispatch, saver/image/save/event
order, files, and parent cache effects. Native saved dates are checked against
each sample's UTC capture window before normalization to `$UTC_SAVE`; candidate
dates must equal the supplied save clock. Generated image-row GUIDs are checked
for nonempty identity, uniqueness and one row per item/type, then replaced
consistently with semantic item/type tokens. No other GUID or field is removed.

`input.json`, `Program.cs`, `Oracle.csproj` and `native.json` are raw sealed
recordings. Do not reformat them. The shared `tests/Directory.Build.props` is
sealed too. Use the lossless JSON parser for inputs and outputs. Provenance
identifies frozen source and assembly hashes, source/output directories, and the
strict dual-database comparison. The initial 35-case recording is retained
externally; the expanded capture preserves its values after the documented
checked save-clock normalization and adds image projections and eight cases.

Provider savers, collection membership, media sources, namespace and image
dimensions/BlurHash are controlled. Files and EF persistence are real; the image
bytes are a processing control and do not establish actual decoder behavior.
This pack verifies matching-child validation on real SQLite and PostgreSQL. It
does not establish removal, type changes, ownership promotion, recursion, remote
images, complete MetadataService, network storage, production full scan, Web
clients, migration, or release acceptance.
