# Guid storage premise before metadata refresh

Stage one tests the premise of the separately recorded lowercase-Guid refresh
risk. It makes no case-insensitive Native lookup assumption. All execution is
in Actions with the same-run designated Native build, migrated SQLite input
and actual PostgreSQL. `EnsureCreated` is not used: the original schema,
collations, migrations and provider are part of this experiment.

The C# producer copies that stopped input, removes its business records in its
private copy and VACUUMs the cleared pages before creating controlled records.
No authentication record is published. Actual LibraryManager/root resolution,
ItemPersistenceService, typed mapper and EF SQLite saving create the positive
control. An explicit EF Data field supplies the declared opaque JSON string.
Its duplicate keys, Int64 text and literal Guid-looking value are input bytes.
The actual save's Guid representation is recorded before a distinct copy gets
one controlled lowercase-D identity. Only that item's Id and actual declared
reference columns are changed by explicit SQLite string parameters. Data,
provider values, paths, the unrelated item and all other values are untouched.
The conversion verifies every table's expected cell set; opaque Data and
provider values contain the target's uppercase text deliberately. The unrelated
item retains its full original Id/Data/provider observations in both controls.
This is a controlled SQLite representation, not a claim that ordinary Native
SaveItems naturally writes lowercase text. The original supplied database
never changes.

The owned frozen transport files are ordinary media, with the explicit external
input `recordings.activeRecordingPaths=[]`. A strict recordings gateway supports
only the actually consumed `GetActiveRecordingInfo(path)` leaf, returns that
declared absence and records each real call. Native `Video.SourceType`,
`GetUserDataKeys`, identity, mapper and `SaveItems` remain actual implementations.

Before freezing either control, the producer also consumes the actual public
`LibraryManager.RootFolder`. Its real AggregateFolder and PlaylistsFolder
initialization runs the ordinary two repository saves and virtual-child link.
The actual ProviderManager has explicitly empty metadata/image parts for this
root-only setup; it still runs the real no-saver selection and library-option
path. No shadow roots are assembled. Provider resources are disposed with any
operation failure retained first. The Node runtime receives the same initialized
application-path domain, and construction, cold/warm reads and export must each
preserve all 31 tables and six insertion sequences. Bounded BaseItems/AncestorIds
cell diagnostics retain original and post-construction/post-read values for a
failure; they do not replace or narrow the complete comparisons.
The recording calls are diagnostic observations; their count is not an
additional acceptance condition.

Two independent producer/reader captures record physical Id/reference/Data
bytes, actual schema and index collations, SQL command/parameter observations,
integrity and FK checks. Fresh actual BaseItemRepository and LibraryManager
instances perform cold reads. A successful public acquisition is followed by a
second public lookup of its unsaved Name, establishing observable warm behavior
without inspecting a private cache. A missing Native cold result is retained;
no constructed object or artificial registration creates a warm success.

Each first-capture SQLite control is imported through production transfer into
a separate PG schema. The actual unstarted runtime performs corresponding
cold/warm public item reads. All 31 tables and six insertion-order streams are
unchanged by these reads. Production export preserves those complete values
and original Guid/Data representations; a new Native process reads each export
and must reproduce its original Native cold result. The cleared controlled
SQLite bytes, raw Native JSON, process receipts and hashes remain in reports.
Build logs and each process's original stdout/stderr/JSON are retained as
byte-count/SHA-256/base64 records, including failure output. Independent schema
absence, unchanged Native/media inputs, actual process exits and runtime/pool
closure are checked before private inputs are removed. A close failure retains
the owned private tree and never reports normal closure or a passing result.

The first-stage test verifies these producer/read/exchange operations. It does
not count an unexecuted metadata operation as a successful refresh. Its report
explicitly distinguishes a Native rejection of the lowercase input from an
accepted input that requires the second stage. Only the latter establishes a
reason to implement the same-domain actual metadata/ExternalDataManager
refresh comparison using same-run public TMDB response bytes. The existing
TMDB test and production code remain unchanged. No result here certifies all
Guid spellings, global Guid normalization, full metadata refresh, external-data
cleanup, complete instances, production scale, phase or release acceptance.
