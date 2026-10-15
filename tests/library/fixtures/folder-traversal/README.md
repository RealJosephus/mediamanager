# Native Folder traversal and root accessibility

This pack records 82 scenarios against the actual protected
`Folder.ValidateChildrenInternal` method in the frozen Jellyfin assemblies. It
preserves the prior 66 physical/version-reconciliation results byte-for-byte,
then adds ten root-accessibility cases and six recursive traversal cases.

The root-accessibility candidate test intentionally selects results 66 through
75 only. Those cases freeze the native ordering and effects for an empty or
missing top-level physical root, a pre-cancelled token, an ordinary non-root
folder, the default `BoxSet` and `collections` exemptions, and
`allowRemoveRoot`. Comparisons include complete 72-column persistence, files,
resolver/deletion/event order, fresh lookup and mutated live-object state, and
parent Children/UserData cache effects on SQLite and PostgreSQL.

The exact `input.json`, `Program.cs`, `Oracle.csproj`, and `native.json` files
were byte-copied from the successful capture recorded in `provenance.json`; do
not reformat them. The source capture is
`D:/mediamanager-validation/20261005/results/folder-traversal-provider-oracle-20261008`.
The six recursive results remain available for the subsequent recursive stage
but are not candidate-tested by the root-accessibility test.

Provider refresh and image processor behavior are controlled. Full child
MetadataService, populated UserData reattachment, linked-reference savers,
network storage, decoder, Web, migrations, full scan, and release acceptance
remain outside this fixture's scope.
