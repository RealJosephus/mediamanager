# Native first-refresh persistence observations

`native.json` is an unchanged copy of the actual frozen DLL recording in
`.test-input/evidence/user-view-refresh-lifecycle-native-v3/native.json`.
SHA-256: `9762bb2b01b77d765a285cdd8f1cd7d6fb5a8027e71bb2fdbf98286179bd4449`.

The recording invokes the actual ProviderManager, UserView and
UserViewMetadataService. Library persistence is a controlled dependency that
records calls without SQL or timestamp writes. Candidate SQLite/PostgreSQL
tests compare the initial-save/provider/final-save ordering and update reasons,
then independently verify committed rows, rollback and concurrent-edit refusal.
Native ReattachUserData, complete host shutdown, public HTTP cancellation,
cross-process races and collage pixels remain outside this fixture's scope.
