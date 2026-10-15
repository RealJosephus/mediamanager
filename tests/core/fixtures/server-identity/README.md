# Native server identity

The oracle executes the designated `DeviceId` with real files. Twenty-seven cases cover N/D/B/P/X GUID text, case and whitespace, empty GUID, BOM-directed UTF encodings, invalid values, missing paths, directories, read-only files and native sharing locks. Repeated access uses the same owner; a fresh owner reads again after sharing locks and read-only attributes are released.

Generated IDs are independently validated as version-four GUIDs before comparing relationships between live, cached, persisted and reopened values. Source text and unchanged files remain exact. Successful generated writes must decode to the live ID; byte framing is preserved in raw recordings. A failed save retains the live generated identity without falsely changing the original file.

The candidate uses the same GUID validation and BOM reader for startup, read-only inspection, instance binding, discovery and restored state. Runtime tests separately cover actual PostgreSQL, HTTP/user DTOs, exact binding, restart and full state-package restoration. This does not establish complete platform or native instance release acceptance.
