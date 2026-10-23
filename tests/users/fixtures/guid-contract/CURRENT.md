# Current GUID consumers

`current/input.json` is a byte-for-byte copy of the original 43-case input, including the original NEL and FEFF characters. The seven original files in this directory remain historical evidence. Current execution does not consume the historical `native.json`, DLL paths, provenance, or required-input seal as expected results.

The three original test entry points now use the designated Native source and runtime built in the same validation run. `current/Program.cs` executes `System.Guid.Parse`, both real JSON GUID converters, and the real `BaseItemMapper.DeserializeBaseItem`. Each original value enters Playlist Data as `{OwnerUserId: value, OpenAccess: true}`. The final owner, access flag, and success or failure are compared with the production Node reader and PostgreSQL `mm_safe_native_item_data` plus `mm_native_json_guid_key` projection. Constructor fallback must discard the access flag along with the invalid owner; errors that escape the mapper must also fail the candidate operation. Exception names and SQL error codes are diagnostic data.

Every value additionally enters the nullable `UserView.UserId` consumer with a valid `DisplayParentId` sentinel. This is a new current observation, not a rewritten historical result. It preserves nullable null, empty GUID serialization, and whole-object fallback as distinct functional outcomes.

For both item types, actual Node deserialization and serialization produce a separate candidate file that Native reads. Native independently reads the neutral original input, serializes its resulting GUID fields with the actual JSON options, and reads that canonical JSON again. Node then reads the same Native JSON. Comparisons use the final consumer values; JSON property order and omitted/default members are not gates.

The current profile pins the local probe sources and input bytes. Each capture records the designated source bindings, same-run build receipt and SDK/runtime identities, loaded assembly hashes, candidate code and JSON identities, build/process outputs, and Native output SHA. PostgreSQL and reverse-reader observations also receive individual file receipts. No media, HTTP server, real Jellyfin instance, or SQLite provider is opened. Required services are `dotnet`, `jellyfinDll`, and `postgres`.

This is bounded GUID and typed Data component evidence. It is not full instance, migration, or release acceptance.
