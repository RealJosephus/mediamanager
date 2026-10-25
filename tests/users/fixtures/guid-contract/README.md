# GUID parsing contract

`input.json` is the neutral input for 43 observations from the actual `System.Guid.Parse` implementation and Jellyfin's nonnullable and nullable JSON GUID converters. The oracle loads the designated Jellyfin build; `provenance.json` binds its source inputs, raw recording, executable and loaded assemblies. Regenerate with `tools/compat/record-guid-contract.mjs` in a fresh isolated output directory.

The cases cover CLR whitespace, JSON null and empty strings, all supported GUID spellings, and the X format's leading zeros, UInt32 fields, low 16 bits in the middle fields and byte limits. Consumers compare public parsing, the PostgreSQL typed JSON gate and the JSON GUID key. Missing SQL values and JSON null remain separate.

The capture controls configuration and invokes these actual parsers directly. It does not prove a complete Jellyfin request, migration, build input closure or release acceptance. PostgreSQL tests require a fresh runtime schema because the verified function fingerprint changes before the first release.
