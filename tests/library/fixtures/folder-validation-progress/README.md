# Folder validation progress

`native.json` is the untouched result of `Program.cs` calling the actual
`Folder.ValidateChildrenInternal` in the reference assembly recorded by
`record.json`. `provenance.json` binds the input, harness, project, result,
execution record and the reviewed reference source files by SHA-256.

The 19 cases cover the early 5/5.5/6/7/8/9/10 phases, empty and 1/24/25/26/50
child batches, retrieval/enumeration/repository/create/delete failures, initial
cancellation and cancellation at 5/5.5/6/7. The every-25-child update precedes
the final processed-children update; both reports of 8 are retained. Native
provider progress is captured for recursive cancellation at 7.

The harness controls `GetNonCachedChildren`, repository reads, creation,
deletion, media protocol and provider notifications. It runs the real parent
validation implementation, including eager enumeration and failure/cancellation
boundaries. It does not run EF, the normal resolver registry, child metadata,
recursive descendants, a watcher or a complete library scan. The source review
of `LibraryManager.ResolvePaths` supplies the eager multi-item versus lazy
single-item enumeration boundary; candidate resolver tests check that handoff.
Candidate PostgreSQL tests separately retain the complete existing native
creation/deletion projections and check progress before the sibling save.

Progress callbacks at 5, 5.5 or 6 may cancel the request. Native resolution and
current-child loading still finish and report 7 before cancellation is checked.
An enumeration failure returns before that check, even if the token was
cancelled during retrieval. Database and provider cleanup are checked separately.

To record again, supply the isolated DLL/runtime environment and a fresh output
directory to `tools/validation/oracle.js`, with this project, the absolute
`input.json` path and `{output}/native.json`. Preserve the original recording;
bind and inspect the new execution before replacing this fixture.
