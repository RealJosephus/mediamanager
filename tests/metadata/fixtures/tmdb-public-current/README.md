# Public TMDB data through the installed Movie provider

This test runs only in Actions with the designated Native input and PostgreSQL.
It uses the existing Node built-in credential, first comparing it in memory
with `TmdbUtils.ApiKey` in the sealed executing source. It does not require a
user instance, account token, local service or test on the developer machine.
Authentication values are removed from request observations and report errors;
the key is neither supplied in the oracle input nor written in plaintext to
reports.

The production Node TMDB plugin makes actual HTTPS configuration and Movie
requests for English/US and Traditional Chinese/Taiwan. Actual response bodies
as delivered by fetch after HTTP decoding are preserved without JSON
reformatting, alongside status, Content-Type, sanitized query, size and SHA-256.
The complete Movie provider output is observed without replacing the provider.
Both ordinary refreshes and warm refreshes run through HTTP, the real metadata
host, PostgreSQL, the Local storage plugin, the original frozen transport's
ffprobe path, and the installed NFO saver. Cast and crew limits are explicitly
zero; this slice does not exercise people or remote image downloads.

The isolated input supplies the canonical UserRootFolder before startup and
uses normal write-path Guid values in the declared database identity columns.
The complete collection/physical-root/Movie input and the actual library
`options.xml`, location link and Movies type marker are installed before startup. Runtime library-option loading and
later rebinding therefore read the same persisted NFO writer policy; no warm
empty-root cache or memory-only options map supplies that policy. Selected
Movie library membership, local saving and the NFO saver are checked on both
ordinary and cold metadata reads, and the options file stays byte-identical.
Preferred metadata language and country occupy their actual scalar columns;
each public provider invocation checks that culture. Complete initial business
rows remain in the report. Each HTTP acknowledgment is joined to the same
item's completed metadata operation, and an actual background failure is
re-thrown with its original cause instead of becoming an absent-result error.
Provider observation delegates through the actual values returned by registry
discovery. Installed plugin provider facades are transient; configuration and
cache replacement therefore continue through the current plugin scope without
depending on writes to a previously enumerated facade.

The rate-limit scenario injects two HTTP 429 responses after the same public
endpoint has succeeded. It requests `FullRefresh` with `replaceAllMetadata=false`:
the actual Native `FFProbeVideoInfo.FetchEmbeddedInfo` independently replaces
Overview, rating and collections from embedded media when replacement is true,
before the remote provider runs. A failed remote call cannot undo that completed
probe. The selected non-replacement request still forces provider traffic and
checks both retry waits, retained persisted metadata/NFO and a subsequent actual
public recovery. Exact request options and both current source files are bound
in the report. It does not claim a real TMDB
rate-limit event. Caller cancellation aborts a real global fetch immediately
after it is initiated; it establishes local transport cancellation without
claiming that the public server accepted that request. The same runtime then
recovers through a successful Japanese/Japan public response.

After ordinary shutdown, a fresh runtime reads the same PostgreSQL and Local
state with all TMDB traffic rejected. HTTP values, unknown provider IDs, media
bytes, NFO readback and the full business-table digests are checked. Every
runtime's actual listeners/database close, and the owned schema pair is checked
through an independent connection after removal.

Cold item HTTP requests use an explicitly created real user ID alongside the
API key. Native `UserLibraryController.GetItem` obtains a user through
`RequestHelpers.GetUserId`; an API key alone has no user identity. The prior
unscoped 400 remains a failed run, rather than a reason to change that production
authorization contract. Every test HTTP response is retained before its status
assertion so a later failure keeps its original body.

Each successful non-warm provider observation binds its exact configuration and
Movie response files. The current designated `TmdbClientManager`, TMDbLib and
`TmdbMovieProvider` consume those files through a replay handler. Every emitted
Movie field is compared, as are query values and a second warm call. Two fresh
Native processes repeat the same inputs. Each process also invokes the current
`BaseNfoSaver.AddCommonNodes` on each actual provider Movie, with empty people,
no user data and image-path saving disabled. Its complete common XML bytes and
genre element order are retained. Every ordinary, failed-provider-preservation,
recovery and cold Node NFO readback must match that Native genre order in both
processes; PostgreSQL still matches the provider's unsorted array exactly. This
component does not claim a Native NFO file save or metadata host. The first
Japanese recovery exposed the erroneous provider-order NFO expectation; its
failed run remains unchanged. Native public transport, all provider
types, complete item DTO comparison, full instance exchange and release
acceptance remain outside this slice. Real network, authorization, public
rate-limit or response failures fail the run; they are not skips or successful
fallbacks.
