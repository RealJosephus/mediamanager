# Default service readers and owned original stream consumer

This fixture executes actual native `DefaultLiveTvService.GetChannelsAsync`, `GetProgramsAsync` and `GetChannelStreamMediaSources`, composed with actual `TunerHostManager` and `ListingsManager`. Only the selected default service's three reader fields are initialized by reflection: its constructor subscribes to `TimerManager.TimerFired`, which belongs to excluded recording execution. The declaration and report explicitly record this constructor boundary. Native providers and configuration lookup are controls; no timer, recorder or stream opens.

Node installs the fixture package through the actual `PluginHost` and composes the actual `LiveTvTunerService`, `LiveTvSourcesService` and `LiveTvService` with real isolated XML configuration I/O from its inherited core `LiveTvConfigurationStore`. Paired observations compare provider call order/cache flags, complete channel projection consumed by this slice, program identity/channel normalization and exception types. Source selection compares declared `MediaSourceInfo` fields, preserving native constructor data flags and request headers; it does not claim a full media-source DTO differential. Actual initialized native source DTOs feed the Node provider control, isolating service selection from a second DTO constructor.

Cases cover all/partial host failures, caught host cancellation exceptions, metadata after host enumeration, metadata failures, channel re-enumeration with cache for program lookup, first ordinal-ignore-case matching channel, missing channel errors, program-provider failure, and source fallback limited to `NotImplementedException` or an empty list. Unsupported, I/O and cancellation source errors propagate. Controlled cancellation exceptions establish the native catch contract, not native timing equivalence.

Separate Node lifecycle cases pause actual installed providers, close the tuner reader and verify combined cancellation, refusal of new work, late-return suppression and owner drain for channels/programs/source DTOs. These do not open raw stream leases or prove native shutdown timing. All configuration/plugin owners close before private files are removed.

The separate stream component input executes actual native
`DefaultLiveTvService.GetChannelStreamWithDirectStreamProvider` with controlled
ITunerHost/ILiveStream inputs, then actual `MediaSourceManager.CloseLiveStream`.
Only the latter method's logger, real ConcurrentDictionary and real
AsyncNonKeyedLocker are initialized. The controlled stream's Open/GetStream
throw: this oracle cannot execute a native network byte open, recorder or
encoder. Native source projections remain limited to the declared source fields.

Fourteen stream cases compare original nullable/empty/whitespace parameters,
case-insensitive first-match selection, a disabled first duplicate followed by
an enabled duplicate, dotted-I identity distinction, first host fallback limited
to FileNotFoundException/OperationCanceledException, non-fallback errors, chosen
group identity, exact provider call order/current descriptors, actual native
ConsumerCount changes and final close counts. Native same-object reuse maps to
the same Node group with independent owned consumer leases; no iterator is
cloned. OriginalStreamId is passed unchanged to providers, separately from the
chosen native MediaSource.Id validated by the formal host. Seed Node groups are
created through the real consumer/provider path and only provider capability
availability is controlled; tests never inject the consumer's private registry.

Additional Node lifecycle tests use installed provider controls to establish
per-caller cancellation, byte-reader ownership, service-bound retention,
registry counts, late open/retain cleanup and shutdown waiting for held close.
These are independent Node lifecycle evidence, not native transport or native
shutdown timing. Original stream groups are ordered; only the first matching
OriginalStreamId is considered before checking enabled. The internal registry
projects only known source/count/sharing data and does not invent TunerHostId or
claim full native capacity metadata equivalence. M3U separately owns its real
input capacities. No public raw stream route, runtime assembly, native byte
transport, media HTTP delivery or complete DefaultService/phase/release
acceptance is established here.

Evidence binds current source files, input/output SHA256 and executing assembly hashes. Inputs are synthetic and contain no credentials. Run only through authorized Actions validation.

Sources: `D:/jellyfin/src/Jellyfin.LiveTv/{DefaultLiveTvService,TunerHosts/TunerHostManager,Listings/ListingsManager,Listings/EpgChannelData}.cs`, `Emby.Server.Implementations/Library/MediaSourceManager.cs`, `MediaBrowser.Controller/Library/ILiveStream.cs`, `MediaBrowser.Controller/LiveTv/{ITunerHost,IListingsManager,ChannelInfo}.cs` and `MediaBrowser.Model/Dto/MediaSourceInfo.cs`, under the project GPL license.
