# Current Year detail lifecycle

`year-detail-http.test.js` supplies this tracked matrix to the existing owned
Native HTTP recorder, using the designated same-run Jellyfin build and a private
instance clone. The reference controller is
`Jellyfin.Api/Controllers/YearsController.cs`; creation comes from
`Emby.Server.Implementations/Library/LibraryManager.cs` (`GetYear` and
`CreateItemByName`) and `MediaBrowser.Controller/Entities/Year.cs`. The producer
retains its actual source/build/input identities and complete HTTP observations.

The 21 requests exercise first creation, repeated reads, canonical numeric
aliases, minimum/maximum positive Int32 values, invalid and overflowing values,
current/selected/zero/missing users, and an ordinary user's cross-user denial.
The Year need not occur in media. A Movie and Audio tagged with 2026 supply real
DTO counts; Year user data uses `Year-2026` and the entity cannot be deleted.

Fresh PostgreSQL repeats the matrix through the production HTTP routes and
normal item creation lifecycle. Every created row column, per-request creation
prefix, original row/table stability and post-close state is checked. Each
runtime's directory creation/modification timestamps are independently bound to
the persisted values before comparing their different wall clocks. The owned
metadata root, ServerId and opaque ProblemDetails traceId are projected. For
400 ModelState errors, the equivalent English templates `is invalid` and
`is not valid` retain the same field, attempted value and error count; their
wording alone does not decide conformance. Original responses remain in
evidence. Registry, listeners and PostgreSQL close
and fixture schema cleanup use the existing lifecycle harness.

`year-detail-lifetime.test.js` separately verifies the Node failure prefix with
real PostgreSQL and Local metadata directories: Year creation commits before a
deferred Users lookup, including five controlled falsy reasons and an actual PG
undefined-column failure. These failure injections are Node evidence, not a
same-run Native fault matrix.

This fixture does not implement or certify `GET /Years`, media scanning,
Native-to-Node exchange continuation or complete-instance release acceptance.
