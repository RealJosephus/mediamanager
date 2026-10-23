# Portable recording evidence

This directory contains unchanged copies of sealed inputs used by the recorded
directory-monitor, UserView-collage, XML prefix, scheduler, splashscreen,
collection-task and folder-progress evidence. The original native outputs and
provenance files remain unchanged. `tools/validation/recorded-input-sources.json`
is the single reviewed packaging plan: every original path and SHA-256 identity
declares its byte count, consumers, sealed target and tracked acquisition path.
The plan also declares the exact source-identity order of the two non-empty
`required-inputs.json` manifests, including the three retained license files.

`tools/validation/recorded-inputs.json` and the monitor/collage
`required-inputs.json` files are deterministic derived indexes. A missing or
conflicting expected digest never selects a bundled file. The XML and other
entries use their existing explicit consumer contracts; this packaging change
does not broaden those gates.

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

`tools/validation/package-recorded-inputs.js` regenerates the derived indexes in
a clean checkout using only the tracked sealed payloads named by the central
plan. It checks every byte count and digest, scans JSON payloads for
secret-bearing fields, and refuses to replace different immutable payload bytes.
It deterministically overwrites only the derived relocation and required-input
indexes. It does not read the old machine-absolute source locations, invoke Git,
unpack source archives, run an oracle, or run a test.

This reproducible packaging path proves that the current tracked payloads and
their indexes agree. It does not claim that every input from every historical
native execution remains available, nor does it turn old runtime/build internals
into current product-compatibility requirements. Historical closure gaps remain
separate from current functional, persistent-format and bidirectional evidence.

`tools/validation/package-jellyfin-source.ps1` prepares the complete source ZIP
from the receipt-bound source copy, retaining each member's exact recorded hash.

The XML prefix additions contain the original recording bytes and three native
source files, checked against the unchanged XML provenance digests. Each source
maps both original source locations to the same byte copy. The missing historical
XML `Oracle.dll` and original runtime assemblies are not supplied by this package;
their separate historical-seal entry keeps those required inputs explicit.
