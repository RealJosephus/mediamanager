# Native full-27 typed item oracle

This fixture seals the current pinned CLR behavior for the exact 27 known
`BaseItem` constructor and mapper type names. It is a type-registry oracle, not
a claim that all 27 types have production filesystem resolvers. The runtime
resolver union remains a separate boundary.

The first 64 cases retain, without deleting or projecting away fields, 27
fresh-constructor and database-overlay cases, 15 malformed JSON-required
cases, 12 malformed source-serialized controls, and ten null, shape, enum,
unknown-property, skip, and unknown-type boundaries. The following 27 cases
each execute the real `ItemPersistenceService.SaveItems` lifecycle at created,
updated, and cleared states. Every one of those 81 stages records the live
typed item, typed JSON, all 72 mapper columns, exact raw and parsed `Data`, all
72 stored columns, every recorded relation family, the cold-hydrated typed
item, control rows, and logs.

The top-level property manifest is produced from
`JsonDefaults.Options.GetTypeInfo(type).Properties` for all 27 item types and
the four nested `MediaUrl`, `LinkedChild`, `PlaylistUserPermissions`, and
`ItemImageInfo` types. It preserves native property order, CLR types,
nullability, JSON and CLR accessor facts, direct versus inherited ignore
attributes, converter metadata, and getter-only fields. In particular,
`Book.SupportsPlayedStatus` and `Book.SupportsPositionTicksResume` are real
getter-only serialized fields even though their base overrides expose an
inherited ignore attribute; `IsHD` and `AggregateFolder.VirtualChildren` are
also getter-only.

`native.json`, `input.json`, `Program.cs`, and `Oracle.csproj` are copied from
the successful r4 recording byte-for-byte. The native file intentionally keeps
its random image and item-value primary keys. Candidate comparison must first
prove every native image key is a nonempty UUIDv4 and unique within the
recording, then recursively replace every occurrence and reference to that key
with its case-and-stage semantic token. It must not delete keys, rewrite the
sealed file, or normalize unrelated values. The original first 64 cases were
independently checked against the preceding 64-case oracle with this exact
rule and were otherwise lossless.

The candidate fixture constructs its controls from `input.json` plus
independent fixed constants mirrored from the recorder source. It must never
use `native.json` to manufacture candidate input. Parsed objects and raw JSON
text are both compared: the raw comparison intentionally covers property
order, N-format GUIDs, seven-digit date precision, null omission, enum text,
and default encoder escaping for non-ASCII and HTML-sensitive characters.

`provenance.json` now records the controlled current-code comparison. The
retained direct TAP ran 114 tests against real SQLite and PostgreSQL: all 113
data, codec, order, and selected runtime checks passed, and the sole failure
was the deliberately false provenance gate before this promotion. The raw
`input.json`, `Program.cs`, `Oracle.csproj`, and `native.json` bytes remain
unchanged. The promoted flag does not turn that intentional-gate run into a
passed batch or prove recursive scans, HTTP, migrations, complete runtime
resolver coverage, or final release acceptance; final strict verification is
recorded separately.
