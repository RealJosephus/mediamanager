# Collection poster maintenance observations

The 26 cases execute the designated `CollectionPosterVerifyPostScanTask` and
`BaseItem.RefreshMetadata` from the pinned assemblies. Root children and the
metadata provider are controlled; this recording does not exercise repository
loading, image composition, HTTP, or a complete library scan.

The input, output, C# recorder and project preserve the archived original bytes.
`provenance.json` binds their SHA-256 values, source files, SDK, assemblies and
process results. The earlier failed recording remains in the validation archive.

Cases cover collection type filtering, image relationships with empty, null or
external paths, duplicates, nullable names, cancellation, root/provider/progress
failure, captured child membership and sibling mutations. The candidate compares
calls, options, progress, failure prefixes, live objects and diagnostics separately
from platform exception class names.

To record again, configure `MEDIAMANAGER_JELLYFIN_DLL` and the matching .NET runtime
then run `tools/validation/oracle.js` with this project and three new absolute
paths: input JSON, instance directory and output JSON. Do not overwrite archived
observations.
