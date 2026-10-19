# Native child aggregation

This fixture executes the pinned `MetadataService.UpdateMetadataFromChildren`
and the real Album/Season overrides. The 59 ordered controls cover update gates,
item and field locks, latest media dates, cumulative Int64 ticks, premiere/year
fallback, genre/studio ordering, localized ratings, album names, frequency-based
artist/provider IDs, rejected IDs, partial in-memory failure and virtual seasons.

`EnableUpdateMetadataFromChildren` is called first. Ordered children and library
options are explicit inputs. Rating resources are loaded by the real native
LocalizationManager. Recording status is controlled as inactive, and the path
classifier supplies the native `IsPathFile` behavior for the supplied inputs.
Input fields are assigned through the actual entity setters: their JsonIgnore
annotations otherwise make normal JSON deserialization silently drop fields.
Unexpected exceptions fail the recording; only the explicit whitespace-ID
ArgumentException control is captured. The projection also retains the native
BaseItem constructor's empty RemoteTrailers array.

`provenance.json` seals native output, input, project, source, build properties,
DLL and runtime identity; `candidateVerified` remains false.

The aggregation oracle excludes child selection, full BeforeSave, repository
persistence, providers, filesystem writes and AfterMetadataRefresh. Candidate
SQLite/PostgreSQL integration checks separately cover actual scalar/relationship
writes, lookup reconstruction, first-save retention, aggregation failure before
first save and Series dates from physical/root-linked children. They do not
claim native full-refresh database snapshots. Date comparison uses native ticks;
the raw recording retains DateTime.Kind, including unspecified MinValue. Empty
Studio arrays follow the native mapper's join/split roundtrip to an empty segment.

The recording culture is zh-CN; broader OS/ICU culture coverage remains pending.
