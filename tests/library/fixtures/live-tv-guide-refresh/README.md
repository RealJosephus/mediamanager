# Native Guide refresh orchestration

The oracle calls the designated DLL's real public `GuideManager.RefreshGuide`.
That method runs its private `GetChannel`, `GetProgram`, guide-day selection,
per-service/per-channel failure handling, progress emission, pre-cache phase
and stale-data cleanup decisions. The actual `LiveTvDtoService` delegates
identities to the actual native `LibraryManager.GetNewItemId`; entities and
`BaseItemMapper.Map`/`DeserializeBaseItem` are real.

Native services, recording-folder coordinator, tuner scanner, library/repository
storage and metadata provider are declared controls. Durable native frames use
the actual mapper and an in-memory collection. Channel lookup has a controlled
live cache; existing programs hydrate independently from durable frames before
the actual `ToDictionary` call. Controlled library writes preserve last-ID
winners and parent-delete cascades. Repository ID selection is controlled
ASCII `SortName` order. No native EF database or SQLite query claim is made.
The input permits only a local image identity with controlled native file
metadata. Native refresh metadata is an observed no-op provider; its internal
provider pipeline is outside this oracle.

The Node side runs actual `LiveTvGuideService`, `LiveTvGuideImages`, PostgreSQL
queries, cohorts, program batches, persistence, metadata updates, channel
metadata refresh and `ItemDeletionService`. The existing private child fixture
supplies its real plugin-backed state filesystem and a mapped memory media
namespace. The PNG used by the guide channel is read through that mapping and
its SHA must survive every refresh and close. Existing-program GUID spellings
remain separate SQL rows until the production dictionary gate rejects them.

Boundary traces compare exact order and complete selected typed snapshots:
folders, scan, service listing, channel creation/update, guide configuration,
program lookup, new save, pre-cache, updated save, pre-cache, explicit channel
update, channel metadata and global cleanup/deletion. Node wraps existing
owners to observe these boundaries; it does not replace SQL/cohort saves or
metadata/deletion implementation. Its metadata provider's internal extra saves
are excluded from the orchestration trace and remain in raw SQL evidence.

All program dates are in 2500. Both actual pre-cache implementations therefore
observe the current cutoff and select no image download workers. This scope
validates invocation order, not image downloads; those have separate real HTTP
pre-cache evidence. Actual provider windows must start one hour before an
instant inside the invocation and retain the exact clamped guide-day duration.
The Guide service receives an explicit live clock callback, independently of
the metadata child fixture's fixed timestamp string. Node's complete observed
error messages and stacks are retained beside the strict error-type trace so
unexpected callback or ownership failures remain diagnosable.
The controlled parent has a different identity from Node's actual named view;
only that explicitly supplied parent is represented as `$PARENT`. Native channel
and program identities remain exact. Changing created/modified/saved clock
fields are outside the selected snapshot, and raw source/Node evidence remains.

`Progress<double>` dispatches native inner callbacks asynchronously and may
interleave them with outer completion reports. The input declares the exact
callback count for each run. A bounded callback-completion promise waits for
that many real reports; no quiet-period sleep is used. Both raw sequences are
retained, and complete value multisets compare to 10 decimal places. Service,
save, metadata and clean order remain strict comparisons.

Cases cover multiple services, all-channel-before-program order, 130 successful
materializations followed by null genres with no prefix persistence, failed
channel creation with its original progress denominator, failed service
continuation, repeated existing program aliases, duplicate existing GUID
spellings, new-before-updated saving, cleanup suppression, repeated empty SQL
selections, zero services and pre-cancellation. Every Node run requires zero
configuration admissions, metadata contexts, SQL item states, cohorts and
observed TEMP tables; the private PostgreSQL schema, adapters and state tree
close through the fixture owners. Current source/build/input hashes are bound
and the supplied stopped instance is verified unchanged.

Every `ILiveTvService` is a non-`DefaultLiveTvService` proxy and rejects calls
outside channel/program reads. The actual native final `OfType<DefaultLiveTvService>`
branch therefore executes no timer or recorder code. Node intentionally omits
that recording-execution branch under the separate R6 cut. This is component
orchestration evidence, not full Guide, native EF, external provider or release
acceptance. Run only through the authorized Actions workflow.
