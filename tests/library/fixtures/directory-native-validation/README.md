# Native `Folder.ValidateChildrenInternal` lifecycle

This pack seals the 47-scenario recording made directly against the frozen
Jellyfin reference assemblies. The harness invokes the protected
`Folder.ValidateChildrenInternal` boundary with recursion and child metadata
refresh disabled. It records directory resolution, eager enumeration,
`CreateItems` persistence, cache effects, events, complete database
relationships, created-item lookup, and every one of the 72 mapped
`BaseItems` columns.

The first 34 scenarios preserve the directory-resolution controls. The final
13 cover cancellation before enumeration, cancellation precedence over a
pending insert fault, first/alternate/link SQL failures, repeat validation,
physical `AggregateFolder` ancestry, and IO/security/general failures from the
second lazy child resolver. Jellyfin catches those three resolver failures and
continues to the generic Folder fallback.

`input.json`, `Program.cs`, `Oracle.csproj`, and `native.json` are exact byte
copies from the external recording identified by `provenance.json`; do not
pretty-print or normalize them. JSON must be read through the repository's
lossless parser because complete projections can contain CLR `Int64` values.
Dynamic Folder creation times were first checked inside the native UTC capture
window and then normalized to `$UTC_RESOLVE`.

This is a narrow non-recursive lifecycle oracle. It does not establish child
metadata refresh, the complete resolver registry, disc/network behavior,
concurrent cache behavior, migration, full library scan, or release acceptance.
