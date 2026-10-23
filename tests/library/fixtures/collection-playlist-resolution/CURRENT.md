# Current Collection/Playlist comparison

`collection-playlist-resolution.test.js` executes `current/Oracle.csproj` against
the designated Native build produced in the same GitHub Actions run. The tracked
`current-profile.json` identifies the neutral scenarios, current oracle source,
project and shared build properties. The original files in this directory,
including `README.md`, `native.json` and `provenance.json`, remain historical
evidence and are not loaded by this comparison.

The 32 cases use real files and directories on the runner. Native executes
BoxSetResolver, PlaylistResolver, ResolverHelper, EF SQLite persistence and cold
hydration. Node observes those same media paths, creates the production entity,
saves through ItemCreationService to PostgreSQL, then loads it through a fresh
service. Fixed IDs, parent lookup, timestamps and identity virtual-path reversal
are explicit controls. Both sides must preserve the neutral media tree and exact
file bytes. Every resolved item retains its identity, parent, name, path, folder
and media behavior, access policy and provider IDs.

Persistence comparisons retain all 72 BaseItems columns, exact raw Data and
parsed Data, provider relations and the cold lookup. The effective winner of the
combined resolver chain is compared through the item it creates. Runtime type
discovery diagnostics are retained in the raw Native capture. Playlist child
validation is exercised with a cancelled token and an unavailable path; it must
complete without progress or storage activity and clear the child views used by
later reads. Separate Node safety cases cover weak directory observations and
fault propagation; an unreadable pipeline input is reported and creates no
fallback item.

Outputs under `collection-playlist-current-*/` retain the source/build identity,
native build and process logs, raw `native.json`, SQLite databases, media trees
and individual candidate observations for resolution, persistence, chain
selection and validation. Capture reports claim only component execution;
phase and release acceptance stay false. The runner's result supplies the
comparison outcome and PostgreSQL cleanup audit.

This fixture covers the two special resolvers and their persistence consumers.
Complete resolver composition, playlist content parsing, full scans, metadata
providers, network storage, HTTP, database exchange and release acceptance have
separate consumers and evidence.
