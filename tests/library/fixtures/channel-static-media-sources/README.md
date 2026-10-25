# Saved Channel media source consumers

The oracle calls actual `ChannelManager.GetStaticMediaSources`, actual private
`NormalizeMediaSources`, typed `BaseItem.GetMediaSources`,
`MediaSourceManager.GetStaticMediaSources/GetPlaybackMediaSources`, and actual
`DtoService.GetBaseItemDto`. It prepares only owned metadata files and actual
typed Video/Channel entities. Native library/item lookup and UserData are
declared controls; visibility still calls the actual typed IsVisibleStandalone
methods. The controlled library path-substitution callback retains the input
path unchanged. Native EF/persistence, physical providers, source media reads, recording,
probing, packet-copy and transcode never execute. Actual BaseItemMapper supplies
the entity columns used by the Node PostgreSQL preparation.

Node reads through the production MetadataImageAssets/StorageFileSystem/local
plugin boundary, reusing the shared actual-JsonDefaults MediaSourceInfo[] typed
reader. LibraryService and DTO use real scoped PostgreSQL, source visibility,
version links, UserData, track preferences, user policy and playback sorting.
Saved-source lookup uses the already admitted SQL connection and batches at
most 128 source IDs. Its result retains saved source order, repeated IDs and
opaque IDs; final playback sorting is a later independent consumer. Node does
not import an official provider or read media with a direct filesystem fallback.

Missing, directory, malformed, null and invalid typed files exercise the actual
silent read/parse fallback. Null members fail after that catch and cannot
masquerade as an empty cache. Private normalization observations retain the
mutated prefix when a later null fails. Cases include constructor defaults,
case sensitivity, valid/invalid duplicate keys, quoted Int64 values, runtime
inheritance, default/hash IDs, nullable stream collections, arbitrary cache
order, opaque/outside-graph/blocked/missing/empty GUID sources, duplicate IDs,
remembered tracks, policy overwrite and real version resume selection.
The readonly recordings dependency is assigned to both DtoService and Video's
actual static property. BaseItem and MediaSourceManager share the readonly
IFileSystem facade whose sole operation delegates to actual ManagedFileSystem's
IsPathFile classifier; source file opens remain forbidden. Every native stage must succeed unless that exact input
declares an expected exception type/status and error source. Fallback lanes also
require one real original-file static source through BaseItem, manager and DTO;
an accidental missing dependency cannot be accepted as an empty-cache failure.
Null tracks distinguish LINQ's ArgumentNullException from OriginalLanguage's
direct FindIndex NullReferenceException, including remembered-audio short circuit.

DTO observations separately check cache-first MediaStreams, unselected or
user-filtered-empty MediaSources followed by an actual userless static read,
extension-based comma-container normalization, SourceType/ChannelName and
selected EnableMediaSourceDisplay and version-based MediaSourceCount. A cache with many rows must not change the
version count. Playback tests distinguish GUID parsing for the preferred source
from exact insensitive source-ID matching, including a D-format ID which is
visible but is not an N-key resume association.

Every observation retains raw native/Node exceptions. Functional failure
comparison uses the actual ExceptionMiddleware status, plus exact argument
messages for HTTP 400. JavaScript engine TypeError and CLR NullReferenceException
messages for HTTP 500 remain raw diagnostics rather than a claim that runtime
exception class names are identical. No failure is accepted as a successful
empty cache after normalization. These are component status observations, not
a substitute for full native HTTP envelopes.

Reads preserve complete PG rows and cache bytes. A final held real cache handle
proves library.close rejects new admission, waits for an admitted token-free
metadata reader, and releases that handle once before all SQL link owners,
the schema and private files are removed. Reports bind input/cache/assembly
SHA-256 and source files. Only Actions executes the tests; this is targeted
component evidence with phaseAcceptance/releaseAcceptance false.
