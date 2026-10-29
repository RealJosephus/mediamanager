# Same-job complete Sintel consumer input

The main cross-platform workflow exposes the explicit `bluray_reference`
promise, which requires `native_reference` and `native_instance`. It provisions
the fixed original in `RUNNER_TEMP/mediamanager-bluray-reference`; the
`blurayReference` service and `MEDIAMANAGER_TEST_BLURAY_REFERENCE` point to its
receipt. A stale receipt without this promise cannot enable a consumer. A
promised missing or changed input fails validation instead of removing tests
from scope.

`provision.js` downloads the entire official Sintel ISO from `sintel.json` and
enforces the frozen 1,593,180,160-byte size, publisher MD5 and SHA256. It then
independently rereads the whole disk file. Each actual runner uses its own
7-Zip UDF reader: Ubuntu's `7zip-standalone` ELF, macOS's `sevenzip` executable,
or the Windows runner's `7z.exe` and `7z.dll`. Tool package observations and the
actual reader's format listing, full ISO member listing, integrity test and
complete extraction remain in the small acquisition artifact. This service
does not call the Linux `bd_info` binary on other hosts.

Windows resolves the actual executable in Program Files/7-Zip explicitly.
The Chocolatey PATH entry is a shim rather than that reader and has no adjacent
7z.dll; the first consumer supply correctly failed when it tried to bind that
shim's nonexistent dependency. The original failed receipt remains unchanged.

The complete extracted tree must match every directory and file in the
unchanged `first-sintel-ci/complete-files.json`. Every original file receives a
complete disk SHA256; all 14 BDMV files and both original M2TS streams remain
present, with 1,592,116,024 total BDMV bytes. The original ISO also remains
available throughout consumer validation. No encoder or media generator
creates inputs, and no partial or substitute disc can satisfy this service.

The receipt binds the current checkout HEAD/tree, workflow/job/run/attempt,
platform, actual Node executable, actual reader and its Windows DLL, producer
files, source descriptor, frozen full member inventory and all five original
publisher metadata files. The validation input reader verifies those bindings,
the whole retained ISO and every extracted member before execution and again
after execution. Only small evidence is uploaded; it cannot supply media to a
later job. The 45-minute download, five-minute no-progress limit and shared
55-minute acquisition deadline retain the 60-minute step budget.

The separate standalone `bluray-reference.yml` and its original Sintel and
AVCHDCoder source records retain their existing identities and results. The
first complete Sintel acquisition in run `40512414913` and the frozen-hash
repeat in `40514418331` prove source acquisition. The consumer component uses
the actual designated Jellyfin Native BDInfo/MediaEncoder and an independent
read-only Node VFS; its scope is documented in
`tests/library/fixtures/real-bluray-current/README.md`. Acquisition alone does
not prove scanning, database exchange, full-instance or release acceptance,
commercial or encrypted Blu-ray support, or menu decoding.

The existing DVD supply already releases its 8.3 GB ISO after complete
verification and extraction, recording `sourceArchiveRetained: false`. It
retains every one of the 60 original VIDEO_TS files for all active consumers.
The Blu-ray service therefore adds its own complete ISO and complete extracted
disc without deleting any input referenced by the DVD service.
