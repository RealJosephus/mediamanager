# Portable recording evidence

This directory contains unchanged copies of the exact files required by the
directory-monitor and UserView-collage recordings. The original native outputs
and provenance files remain unchanged. The relocation table is
`tools/validation/recorded-inputs.json`; each original path and SHA-256 pair has
one exact target and byte count. A missing or conflicting expected digest never
selects a bundled file. `required-inputs.json` beside each fixture binds its
additional helper/source/record inputs and the retained license files.

`recordedInputPath` resolves these files only for reading recording evidence.
It does not select a runtime or executable. In particular, the Windows
`dotnet.exe`, Jellyfin assembly and oracle assemblies are immutable hash inputs
on Linux and macOS; they are never launched there. The separate oracle runner
still needs its configured .NET installation and full Jellyfin runtime.

The packed JSON records contain synthetic fixture observations, source paths,
build and process commands, and hashes. No server instance, database, user
media, credentials, environment dump or machine configuration is packed.
The build receipt retains the recorded build identity. Copying that receipt
does not re-audit or reproduce its complete SDK, package and build-input
closure on a CI runner. Replaying Windows observations on another platform
does not establish a new native recording for that platform.

Jellyfin source files and assembly retain the accompanying GPL license in
`LICENSE-Jellyfin.txt`. The complete corresponding designated source is supplied
in `jellyfin-source-208c278b75ab.zip`: all 2,620 files in the original source
manifest, including all 19 modified tracked files and the added source file.
No source entries were excluded; original upstream documentation and build
helpers are retained. `jellyfin-source-package.json` binds the archive, the
unchanged source manifest and local-modification record, the license, the native
DLL and the unchanged build receipt. This preserves the actual working-tree
source content rather than replacing it with an upstream commit checkout.

The .NET host's original `LICENSE-Dotnet.txt` and
`ThirdPartyNotices-Dotnet.txt` are also retained without editing. The package does
not distribute SDK, operating-system or NuGet runtime binaries or claim a newly
reproduced build.

`tools/validation/package-recorded-inputs.js` prepares this narrow package from
the recorded originals, checks every original byte count and digest, and refuses
to replace existing different package bytes. It runs no oracle or test.

`tools/validation/package-jellyfin-source.ps1` prepares the complete source ZIP
from the receipt-bound source copy, retaining each member's exact recorded hash.
