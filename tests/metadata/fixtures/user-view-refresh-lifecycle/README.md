# Native first-refresh persistence observations

`native.json` is an unchanged copy of the actual frozen DLL recording in
`.agent-docs/evidence/user-view-refresh-lifecycle-native-v3/native.json`.
SHA-256: `64b2741c37d5ccf69579e3ab34d938986988444e32b2f07d34a4c00ec840681a`.

The recording invokes the actual ProviderManager, UserView and
UserViewMetadataService. Library persistence is a controlled dependency that
records calls without SQL or timestamp writes. Candidate SQLite/PostgreSQL
tests compare the initial-save/provider/final-save ordering and update reasons,
then independently verify committed rows, rollback and concurrent-edit refusal.
Native ReattachUserData, complete host shutdown, public HTTP cancellation,
cross-process races and collage pixels remain outside this fixture's scope.
