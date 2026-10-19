# Native HTTP filter evidence

Album and genre expected responses are mechanical projections of complete
native Jellyfin HTTP recordings. The source inputs contain independently declared
synthetic media rows; expected responses are never produced by the candidate.
The recorders also retain full database and filesystem stages, process exits,
port checks, source files and the complete native Release runtime manifest.

`tools/compat/prepare-http-filter-reference.mjs` initializes a fresh native
instance from an empty directory with the specified DLL, performs native startup,
creates CoreFlowAdmin through the actual Users API, elevates its policy and
authenticates it. After authenticated shutdown it remaps that synthetic user's
Guid references to the input fixture's fixed user ID, preserves native password
hashes and permissions, seeds two declared Folder/Movie templates, checks all
foreign keys and saves `initial.db`. `bootstrap.json` records the API observations,
original and remapped identities, changed reference counts, migration history,
before/after database identity, script and executable hashes. This remapping is
test-input preparation; it does not recreate the vanished historical instance.

`filter-reference-inputs.mjs` requires that stopped preparation and binds its
report, log, scripts, model, source manifest and executables before recording.
The recorders copy the input; they never start or modify the prepared source.
Use explicit MEDIAMANAGER_TEST_NATIVE_INSTANCE, MEDIAMANAGER_TEST_NATIVE_SQLITE,
MEDIAMANAGER_DOTNET and MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT values. Map the
logical evidence roots with MEDIAMANAGER_VALIDATION_INPUT_ROOT; output directories
must be new children of MEDIAMANAGER_VALIDATION_OUTPUT_ROOT.

```powershell
node tools/compat/prepare-http-filter-reference.mjs <dotnet> <jellyfin.dll> <ffmpeg> <new-instance> <baseline-manifest>
node tools/compat/record-genre-filters.js .agent-docs/evidence/genre-filters-native-v1 18154 main
node tools/compat/record-album-filters.js .agent-docs/evidence/collection-view-multi-root-frozen-v1 18700 main
node tools/compat/project-genre-filter-fixture.js
node tools/compat/project-album-filter-fixture.js
```

The 2026-10-03 second recordings contain 34 genre cases/68 GETs and 59 album
cases/112 GETs, using separate native copies. Genre reads leave all projected
database and filesystem state unchanged. Album reads create one Playlists
UserView and its metadata directories; exact added-row and directory deltas,
unchanged existing rows and repeat-request stability are required. Its
databaseUnchangedByReads/filesystemUnchangedByReads flags are therefore false.
The album projector has no dependency on an old development-version projection;
both projectors reject failed or incomplete native main contracts.

Native fixture integrity tests verify raw HTTP, side effects and all recorded
hashes. Candidate HTTP tests use that same authoritative album database stage
and compare SQLite and real PostgreSQL, including the UserView creation and
refresh queue. Run through the configured strict validation entry point to bind
candidate and inputs before and after execution. Missing inputs, failures or
skips do not count as completion. These finite matrices do not establish full
library or phase acceptance.
