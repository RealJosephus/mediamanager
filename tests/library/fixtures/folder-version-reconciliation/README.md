# Native video-child reconciliation

This pack invokes the actual protected nonrecursive Folder.ValidateChildrenInternal
in the frozen Jellyfin assemblies, after real warm CreateItems and EF SQLite saves.
All 40 physical-child results and the first 52 extended results are retained unchanged.
The 66 scenarios add ordinary Movie/MusicVideo primary replacement, demotion,
alternate removal, independent creation/deletion/repository-update failures,
saver cancellation and image commit before a later item-save failure.

Two-file replacement separately records successful old-primary deletion and an
actual deletion-trigger failure. Three-file replacement records the frozen
DbUpdateException: DeleteItem consults the persisted old local links after the
in-memory arrays have been cleared, promotes the new primary again, and its
orphan deletion encounters an incoming old link. The deletion trigger in that
case is not reached; it is not evidence of a successful deletion or trigger fault.
Do not alter the native output to turn that branch into a success.

Every comparison covers all 72 BaseItems columns, complete typed Data, image
and ordinary relationships, files, saver/repository/event order, parent cache,
the original mutated live object and the separate cached lookup. Native UTC dates
are checked within the capture window before normalization; candidate dates must
use the supplied clock. Generated image GUIDs are validated for nonempty identity,
uniqueness and item/type correspondence before consistent token substitution.

Raw input.json, Program.cs, Oracle.csproj and native.json, plus the shared
tests/Directory.Build.props, are byte sealed. Preserve raw bytes and use the
lossless parser for CLR Int64 values. Source/runtime identity and independent
source/output locations are recorded in provenance. The first failed version
capture remains separately archived and supplies no complete output or pass count.

Files and EF persistence are real. Provider savers, image dimensions/BlurHash,
collection membership, media sources and namespace are controlled. Linked-reference
savers, populated UserData key reattachment, recursive validation, complete
MetadataService, actual image decoding/network, full production scan, Web clients,
migration and release acceptance remain outside this pack. The 66 scenarios passed strict comparison on real SQLite and PostgreSQL; the selected 11-file execution passed 807/807 with complete registration and stable candidate/input identity. phaseAcceptance remains false. See provenance for exact evidence and scope.
