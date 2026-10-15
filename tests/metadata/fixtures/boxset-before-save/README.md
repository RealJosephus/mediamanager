# BoxSet affiliation lifecycle oracle

The 51 controls execute the pinned actual `BoxSet.GetLibraryFolderIds`, nested
BoxSet traversal, linked child resolution and `LibraryManager.GetCollectionFolders`;
26 call actual `BoxSetMetadataService.BeforeSaveInternal`, and 25 call actual
`None` refresh with `ProviderManager`. The actual mapper records the serialized
`LibraryFolderIds` field separately from controlled repository callbacks.

The recording covers absent/null/empty/matching/stale/reordered/duplicate caches,
Guid casing, link and root order, duplicate members, nested collections and
cycles, item/field locks, ordinary folders, unknown affiliation, physical-ID
versus path membership, exact ordinal path semantics and null-location failure.
One missing-member lookup control is only a direct traversal check; it is not a
native SQL or candidate persistence claim.

Typed entities, cached physical/root children, ItemId query/lookup, default
library options, absent files, identity path reversal and repository callbacks
are controlled. Affiliation results, flags and mapper data are produced by the
actual DLL. No native HTTP, SQL, NFO, filesystem or external collection link merge
is executed. The candidate `None` refresh consumer uses SQLite and real PostgreSQL,
checks save/event order, the serialized field, unchanged links, and no save after
membership failure. Full BoxSet external link merge and remote save failure chains
remain separate work.

`provenance.json` seals the input, output, source, project, shared build properties,
actual recording, baseline sources, SDK, DLL and timezone. Raw evidence keeps
`candidateVerified: false`; candidate strict-run results are separate.

With the repository validation environment configured, re-record into a fresh
isolated directory:

```powershell
node tools/validation/oracle.js tests/metadata/fixtures/boxset-before-save/Oracle.csproj D:/isolated-validation/results/new-boxset-oracle tests/metadata/fixtures/boxset-before-save/input.json '{output}/native.json'
```

Copy the actual output and recompute provenance after a source/input change.
