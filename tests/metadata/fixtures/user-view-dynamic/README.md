# Frozen dynamic UserView image provider observations

`native.json` preserves all five raw native observation records and SHA-256
bindings for the oracle, stdout, frozen provider/filesystem sources and DLL.
The test pins its complete byte hash. `project-native.mjs <native-v2>` is the
development-only projection command; it never replaces an existing fixture.

The oracle executes the actual frozen `DynamicImageProvider` and
`ManagedFileSystem`. A derived UserView controls its item query and internal
path; interface proxies control the collage processor and SaveImage. Tests
compare missing-file change decisions, empty/failing query outcomes and
query counts. Actual candidate library queries and metadata host failure,
cancellation-before-persistence, serialization and recovery are also tested
separately on both databases. These candidate host checks do not prove a
native host cancellation/race differential. Real collage pixels and
SaveImage remain unimplemented and unaccepted.
