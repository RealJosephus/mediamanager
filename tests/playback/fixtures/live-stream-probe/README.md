# Live probe and MediaInfo cache components

The designated GPL-2.0-only sources are
`Emby.Server.Implementations/Library/LiveStreamHelper.cs`,
`MediaSourceManager.cs`, typed `MediaInfo`/`MediaSourceInfo`/`MediaStream`,
`MediaInfoRequest`, `ILiveStream` and `JsonDefaults.Options`. The test binds
their current source files and hashes, executes actual designated assemblies
and retains assembly/input/output hashes, raw JSON and before/after cache bytes.
Only Actions executes these tests.

The native process calls actual LiveStreamHelper.AddMediaInfoWithProbe. Its
manager cases use an actual MediaSourceManager constructor and
OpenLiveStreamInternal, a controlled IMediaSourceProvider returning a
controlled ILiveStream, and actual manager catch/fallback/AddMediaInfo and
typed JSON cloning. Other fallback cases invoke the actual private static
AddMediaInfo after the actual helper fails. The controlled stream's Open and
GetStream throw; the recorded counters must stay zero. No native
SharedHttpStream.Open, original-copy file, recording or transcoding executor
runs. The IMediaEncoder result is a controlled typed MediaInfo and not an
actual ffprobe process. Actual network ffprobe evidence belongs to the
independent production HTTP tests.

The Node side calls the production `LiveStreamProbe` and `addLiveMediaInfo`.
For input cases named `manager`, its catch/fallback/clone wrapper is controlled
test orchestration; this file does not call the formal `LiveStreamsService`.
The report sets `nodeProductionManagerExecuted: false` explicitly. Only the
native side executes the actual `MediaSourceManager` entry point. Agreement
here does not certify the Node public manager's cancellation or fallback path;
that requires the separate public service/HTTP evidence.

Cases cover constructor defaults, exact field case and ignored unknown/read-only
properties, quoted numbers and large Int64 values, duplicate invalid earlier
known fields, strict booleans, null collections/root, nullable dictionary values,
first AV reduction only with a nonempty cache key, index/language mutation after
the cache save, runtime preservation, bitrate inference and IsAVC changes.
Native cache bytes are consumed by a fresh production Node reader/helper.
Node first produces a cache using the production LiveStreamProbe and real files;
those exact hashed bytes are fed to both an actual native typed MediaInfo reader
and an actual helper cache hit whose controlled encoder would fail if invoked.

JSON property ordering is compared at its actual typed-reader layer, while
full raw bytes and hashes remain in every report. The physical OpenOrCreate
writer is observed without truncation: a shorter valid prefix retains the
original 16000-byte invalid tail and the next cold read reprobes. Each engine's
unchanged suffix, actual length and repeated encoder invocation are checked.
Null returned MediaInfo/null stream collections are written before their later
failure. Manager cases include cache hit, known-index bypass, real minimum
delay, cancellation during delay, cancellation inside a controlled encoder and
probe failure followed by the actual manager fallback. Timing assertions use
the measured request-relative lower bound, not equality of instance clocks.

Separate Node lifecycle cases suspend an actual cache-file write and a real
private HTTP byte reader/cleanup. They prove that close rejects admission and
waits for owned files/readers/server cleanup. Controlled suspension is declared;
it is not a claim that native filesystem writes were suspended equivalently.
Every output keeps phase/release acceptance false. No public playback or actual
ffprobe execution is certified by this component suite.
