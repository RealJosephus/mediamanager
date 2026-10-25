# Current-platform Playlist visibility

This thin oracle reads the same sixteen raw inputs from the unchanged
`../playlist-path/native.json`. It invokes the supplied current-platform
Jellyfin DLL's real `Playlist.IsSharedItem`, `IsVisible` and
`IsVisibleStandalone` getters. Application paths, parent lookup and empty
collection membership use the same controls as the historical Oracle.cs;
path and visibility results are never mocked.

Both sides receive the exact recorded `ProgramDataPath` and `DataPath`,
including their Windows-looking raw spelling on POSIX. The candidate uses
its existing explicit `dataPath` option so a host path join cannot alter
the input. The current OS's native path semantics determine the expectation.
No Windows emulation, filesystem fixture, SQL database or HTTP host is added.

`playlist-path.test.js` retains the original seal and Windows helper controls.
Its visibility test records this separate oracle through `recordOracle`,
binds the input hash and loaded Jellyfin assembly to the build receipt, and
compares all sixteen direct/standalone results. The original Oracle.cs,
native.json and their pins remain untouched. Build output, raw getter results,
receipt and candidate observations are saved outside the repository.

Run only in GitHub Actions with `native_reference=true` and exact selection
`tests/library/playlist-path.test.js`. Ownership, open access and share variants
remain outside this fixture's scope.
