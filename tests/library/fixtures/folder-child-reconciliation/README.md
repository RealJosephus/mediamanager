# Native physical-child reconciliation

This pack records 40 scenarios against the actual protected nonrecursive
`Folder.ValidateChildrenInternal` method in the frozen Jellyfin assemblies.
Setup performs real warm CreateItems and EF SQLite saves. A nested-Folder case
also validates its existing Movie children before the measured outer operation.

Cases cover physical Movie, MusicVideo, Video and Folder removal; same-path
collection-type changes; Folder collapse and video expansion; internal image
cleanup; new siblings; empty physical roots under AggregateFolder; deletion and
later creation SQL failures; and scan cancellation during external cleanup.
The latter creation/cancellation failures retain completed deletion and Removed
events, as in the native independent persistence boundaries.

Every comparison includes all 72 remaining BaseItems columns, complete typed
Data, image and ordinary relationship rows, files, resolver and persistence call
order, events, parent Children/UserData cache effects, and the original mutated
live object's before/after state and cached lookup. The live setup object remains
distinct from the fresh current-child query object. Deleted cache lookup and a
retained original object therefore have different expected states.

Raw `input.json`, `Program.cs`, `Oracle.csproj` and `native.json` are byte sealed;
the shared `tests/Directory.Build.props` is sealed too. Do not reformat raw files.
Read inputs and recordings with the lossless parser to retain CLR Int64 values.
Provenance binds frozen source/assemblies and the independent source/output
directories. Saved and resolve dates are checked against the native UTC sample
window and candidate supplied clock. Generated image GUIDs are validated for
nonempty identity, uniqueness and item/type correspondence before consistent
semantic-token substitution.

Files and EF persistence are real. Provider savers, image dimensions/BlurHash,
collection membership, media sources and namespace are controlled. This pack
does not establish alternate-version promotion, linked-reference saves, UserData
key reattachment, recursive validation, complete MetadataService, actual image
decoding, network storage, production full scan, Web clients, migration or
release acceptance. The 40 scenarios have passed strict comparison on real SQLite and PostgreSQL. The selected 10-file execution passed 674/674 with stable candidate/input identity and complete registration; phaseAcceptance remains false. See provenance for the exact evidence and scope.
