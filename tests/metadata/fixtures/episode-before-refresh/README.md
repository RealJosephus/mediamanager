# Episode naming and refresh oracle

This fixture records 490 controls against the pinned modified Jellyfin DLLs:
actual `EpisodeResolver`, native naming expressions and BMP regex word ranges,
`LibraryManager.FillMissingEpisodeNumbersFromPath`, `Episode.BeforeMetadataRefresh`
and `EpisodeMetadataService` with actual `ProviderManager` discovery, plus actual
`BaseItemMapper` date projections.

The inputs cover standard, anime, absolute and optimistic names, date patterns,
invalid dates, range-end guards, supported extensions and stubs, generic-parent
fallback, typed season fallback, item/field locks, Library/LiveTV/Channel sources,
embedded MP4 gates, missing/nonpositive/whitespace tags and probe failures. The
service controls cover all four refresh modes, first and existing records,
forced replacement, absent/unchanged providers and provider cancellation. They
record provider lookups, first/final save callbacks, reattachment counts and
refresh stamps; dynamic stamp values are compared by whether they changed.
Date controls include years 1 through 9999, historical Taipei offsets, exact
minimum and 100 ns after minimum values, nullable PremiereDate/EndDate,
nonnullable date sentinels and the exact first-refresh minimum gate.

Physical entities, reference lookup, library options, missing file metadata,
media sources, identity path reversal, encoder results/failures, empty remote responses and repository
callbacks are controlled. The DLL does not perform real SQL, filesystem or
ffprobe operations here. Runtime date inputs use Asia/Taipei. The actual Windows
CLR timezone has no adjustment rules and therefore applies UTC+8 even where
Node's IANA data uses historical minute offsets or DST. The recorder exports
the native fixed Windows timezone definitions for the candidate calendar-date
converter; date behavior in other zones remains unverified. Zones with native
adjustment rules still use Node's local conversion and need independent validation.

The candidate consumer runs the hook and save projections against SQLite and
real PostgreSQL, checks serialized `BaseItems.Data` together with relational
columns, and checks probe reloads, request cancellation and shutdown. The separate
`episode-embedded-probe-actual.test.js` test copies the frozen MPEG-2 video
packets described in `tests/fixtures/frozen-av/` into an MP4 with declared
episode tags, verifies the selected packets and timing, uploads those bytes to
actual AList and rclone WebDAV services, invokes real ffprobe through a VFS HTTP lease,
and verifies that the embedded read does not persist technical or descriptive
fields before the explicit save. This does not prove the complete remote
metadata/NFO failure chain or a complete library scan.

`provenance.json` seals input/output, recorder, project, shared build properties,
the production `episode-patterns.json` and `calendar-timezones.json` projections and the referenced baseline
sources. It binds the actual oracle recording, SDK executable, DLL and timezone.
The raw recording and provenance keep `candidateVerified: false`; candidate
strict-run results remain separate evidence.

To re-record in a fresh isolated output directory:

```powershell
node tools/validation/oracle.js tests/metadata/fixtures/episode-before-refresh/Oracle.csproj D:/isolated-validation/results/new-episode-oracle tests/metadata/fixtures/episode-before-refresh/input.json '{output}/native.json' '{output}/patterns.json' '{output}/calendar-timezones.json'
```

Set the DLL/.NET paths and TZ using the repository validation environment first.
Copy the actual new outputs and recompute provenance after source/input changes;
never replace a mismatched native result with a candidate-generated expectation.
