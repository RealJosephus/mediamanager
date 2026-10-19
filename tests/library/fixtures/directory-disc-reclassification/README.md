# Native directory-disc reclassification

This pack records 18 scenarios against the actual protected
`Folder.ValidateChildrenInternal` method in the frozen Jellyfin assemblies.
Each scenario performs genuine `LibraryManager.CreateItems` and EF SQLite
persistence for a resolved DVD or Blu-ray directory stack, mutates the physical
layout, and invokes the real existing-item reconciliation path.

The original 13 scenarios remain stable: nine same-identity stack updates,
three strong three-to-two primary-loss cases, and the nonrecursive
two-to-Folder immediate control. Removing the new `recursiveIdentityKeys`
observation from those results reproduces the previous result bytes exactly at
SHA-256 `9c734fb1350281f005b39073f3640df8407fbabd120bf2ed8357aa1b453bf1ee`.

Five appended cases run native recursive validation. The successful lifecycle
is delete old Movie -> `ItemRemoved` -> save outer Folder -> `ItemAdded` -> save
nested direct-disc Movie -> `ItemAdded`. The nested Movie is a fresh identity
under the outer Folder, owns no versions, and does not inherit curated metadata.
The pack also records outer creation failure, scheduler-isolated nested creation
failure, and cancellation immediately after the outer `ItemAdded` event.

The populated UserData/provider/manual-link case is intentionally a negative
migration result. Native reattachment checks the immediate outer Folder before
recursive validation. The later nested Movie exposes the shared Imdb key, but
native never performs a second reattachment pass: both old UserData keys remain
on the deletion placeholder with retention dates, and the old Manual link is
deleted. Candidate tests hard-assert this call-time boundary.

`input.json`, `Program.cs`, `Oracle.csproj`, portable-LF `native.json`, and the
shared `tests/Directory.Build.props` are byte sealed. The successful raw capture
is under
`D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/results/directory-disc-reclassification-oracle-v19-clean-pinned`.
Its `record.json` SHA-256 is
`026446af11ce399ec7aea41c58100e46109acbfd19b903f2227c399ff7e94493`;
the aggregate source-files seal is
`8a32eb8f380d5da42e981cd7295a1cbd20f606162992233bd245e72d3940fe05`,
and the recorded oracle assembly SHA-256 is
`be5f2085221e9f9fb438917c49316754f0e66db6674b61c66eb322d6e7aa6b2b`.
Its raw CRLF `native.json` SHA-256 is
`7e971e343fd2c7d2743a772400fc9f2dc208024bce92de148bfe5952bcd88366`;
the checked-in LF-normalized file is
`77983ae799fc754358af19f240c2dbf4a400d4561c7411a4eff2167b4cbdf411`.
The final LF is retained and no CR bytes remain. Provenance lists failed and
superseded captures rather than overwriting them.

The capture uses the clean detached checkout at
`D:/mediamanager-validation/20261008/jellyfin-pinned-208c278/source`, verified at
HEAD `208c278b75abd897aefa1e1175126eac5e4dbfaa` with empty porcelain status.
Its independently built Release `jellyfin.dll` is 514560 bytes with SHA-256
`14a821378e554f3a1476610b02ef7ad3795fbb4050872413180ee423bd612d01`.
Every pinned source seal is calculated over raw `git show HEAD:<path>` bytes;
the set includes `LimitedConcurrencyLibraryScheduler.cs`, whose scheduled
exception boundary determines nested validation failure isolation.

The actual oracle uses real filesystem, resolver, EF SQLite, persistence,
limited-concurrency recursive scheduler, and event behavior. Provider savers
and explicit failure triggers are controlled. Complete MetadataService,
network storage, Web, and release acceptance remain outside this fixture.

Candidate verification used real SQLite and PostgreSQL:

- The actual oracle/seal command passed 19/19.
- Focused directory-disc production tests passed 84/84.
- The resolver/scanner adjacency partition passed 476/476.
- The deletion/version/UserData adjacency partition passed 594/594.
- `npm run check` passed.

The production tests cover exact event/save/delete order; outer and nested
ownership/parentage; fresh metadata; no recursive UserData reattachment; outer,
nested, and cancellation prefixes; same-ID and three-to-two preservation; and
pre-side-effect rejection for ID/path collisions, owned deletion closures,
version families, alternates, mixed sources, nondeletable sources, weak or
incomplete snapshots, extra actions, and live family mutation.
