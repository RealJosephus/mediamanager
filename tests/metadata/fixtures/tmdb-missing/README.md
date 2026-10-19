# Native TMDB disabled-cleanup observations

`native.json` records the actual isolated Jellyfin assemblies built from the
specified source snapshot. It compares 22 entity cases: 20 disabled FetchAsync
cases and 2 enabled cases limited to membership and HasChanged, plus 8 separate
HasChanged cases including absent plugin, non-Series and empty provider ID. Active TMDB
import is excluded from Fetch comparison. Cached entity children and dependency
lookups are controlled inputs; DeleteItem records requests without SQL or files.

`persistence-native.json` separately records actual ItemPersistenceService EF
SQLite deletion against `persistence-input.mjs`'s isolated synthetic native schema.
The twelve table projections cover ownership, associations, UserData conflict
selection, exact Int64 ticks, RetentionDate, people, item-value cleanup and explicit
deletion of display preferences, media segments and trickplay rows without BaseItems foreign keys. They
do not prove alternate-version promotion, external-asset deletion, library
notifications, complete native migrations or active episode import.

`provenance.json` binds the input, C# source/project, SQL seeder, model, reference
manifest, loaded assemblies, native SQLite library and before/after database
hashes. The two native SQL retention timestamps must be identical and lie within
the recorded operation interval. Candidate comparison injects that timestamp
without discarding its value or precision. Unordered SQL table projections are
sorted for comparison; entity traversal and removed-ID order remain exact.

Dual-database regression also inserts new ParentId, OwnerId and AncestorIds
relations after initial selection but before the first and second independent
deletion transactions. Each must reload persisted relationships and retain the
new children's UserData. This same-connection injection complements the separate
cross-process SQLite reviewer control; it is not a native PostgreSQL execution.

From the repository root, provide explicit isolated inputs and a fresh output:

```powershell
node tools/compat/record-tmdb-missing.mjs <assembly-directory> <dotnet-executable> <sqlite-native-library> <fresh-output-directory> <baseline-manifest>
node --test tests/metadata/tmdb-missing-episodes.test.js tests/metadata/tmdb-missing-differential.test.js tests/metadata/tmdb-missing-persistence.test.js
node tools/compat/check-tmdb-missing-baseline.mjs <baseline-git-ref> <control-output-directory>
```

Configure MEDIAMANAGER_TEST_POSTGRES for the PostgreSQL branches. The recorder
uses the supplied dotnet executable and existing SDK/NuGet environment. Reviewed
native results can be copied into this fixture directory together with their
provenance. The baseline control loads only the two selected baseline modules,
using current dependencies and regression tests. It must detect each of the six
confirmed deletion-scope failures and finish normally with a failing test result.

No stage acceptance is claimed by these recordings or tests. Active Fetch is
intentionally outside this sealed oracle: its lifecycle, persistence and runtime
wiring are covered by the separate active SQLite/PostgreSQL integration tests.
