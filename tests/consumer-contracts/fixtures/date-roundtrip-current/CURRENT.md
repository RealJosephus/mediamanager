# Current date HTTP and database exchange

The test executes this workflow's designated Native build and initialized private
instance. The historical `date-roundtrip` reports and provenance remain
unchanged and are not an execution dependency or expected response.

The neutral input retains `date-295` (1990 explicit offset) and `date-296` (1900
unspecified local time). It adds UTC, positive and negative offsets, unspecified
local time, and minimum/maximum dates with seven fractional digits. A current
Native component records actual `JsonDefaults`, `UpdateUserItemDataDto` and
`DateTimeKindValueConverter` consumption. Kind names are diagnostic; the consumed
UTC value and complete precision are verified through real HTTP and persistence.

Native creates a real photo library and scans eight files to obtain the UserData
targets. It writes each date through HTTP and stops. For each declared Node
timezone (UTC, Taipei and Shanghai), the test imports the complete SQLite into a
fresh PostgreSQL schema and starts the production entry point in a separate
process with `TZ` explicitly supplied. HTTP reads the original Native state,
writes dates and a changed play count, then closes. A new PostgreSQL connection
and production process read the saved state before complete SQLite export.

The stopped private Native instance takes over the export, reads every saved
date, and continues through real HTTP with new 100ns UTC values, favorite state
and play count. Its stopped database is imported into another fresh PostgreSQL
schema and read through another production Node process. Every transfer compares
all business tables, insertion order, migration history and SQLite sequences;
the UserData values are also checked directly at each boundary. Source files
remain unchanged. Processes, ports and owned schemas must close cleanly.

Node conversion uses its built-in timezone data. Native's actual local timezone
and each Node process's requested and resolved timezone are recorded. Explicit
UTC/offset instants must agree exactly. Unspecified local values must match the
current Node timezone conversion and must remain unchanged on subsequent reads
and transfers. Historical platform timezone offsets are observations rather than
fixed old expected differences. ISO trailing zeros are projected only after
preserving the complete raw HTTP body; no millisecond-only conversion is used
for assertions on stored or returned dates.

This is an eight-Photo UserData exchange scenario. It does not establish an
arbitrary library lifecycle, a full state package or release acceptance. The
required services are `dotnet`, `jellyfinDll`, `nativeInstance` and `postgres`;
GitHub Actions supplies `native_reference=true` and `native_instance=true` on
all three platforms. No machine timezone change is made.
