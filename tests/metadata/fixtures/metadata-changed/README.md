# Native metadata change ratings

This fixture calls the pinned BaseItem.OnMetadataChanged with real rating
inheritance and LocalizationManager resources. The 31 method controls include
unchanged scores, zero/null scores, lone stale subscores, custom/unrated/unknown
values, display versus physical parents, country precedence, null country
failure, locks and repeated calls after explicit field changes.

Four additional controls call the actual ItemUpdateController and capture
UpdateItemAsync callbacks. Child updates observe edited parent ratings before
the parent's later country assignment. Subsequent lock propagation saves those
scores without another OnMetadataChanged call.

Five pathless Movie controls execute actual MovieMetadataService.RefreshMetadata
and ProviderManager discovery with controlled custom/local-image providers.
They cover a successful Default pass, ValidationOnly force save, provider/image
failure gates and the first save retained after provider cancellation. Raw native
refresh timestamps remain in the recording; comparison uses whether the initial
stamp changed rather than equating wall clocks from different executions.

`provenance.json` seals input, raw native output, source, project, build
properties, DLL and runtime. `candidateVerified` remains false. Service controls
use the actual ProviderManager.

Parent entities, library options, empty collection folders/alternate versions
custom/local-image providers, inactive recording lookup and repository callbacks
are controlled. HTTP, native repository writes, NFO, media file operations,
person creation and failures of those external writes are excluded. Candidate
SQLite/PostgreSQL integration separately checks actual rating persistence,
refresh gates, first-save/cancellation boundaries, probe reload and edit order.
