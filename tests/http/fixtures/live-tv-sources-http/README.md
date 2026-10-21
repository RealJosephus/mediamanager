# Live TV source management HTTP evidence

Before the first private native startup, the bound synthetic media seed is
relocated to real retained files inside this fixture's declared source mount.
Both HTTP fixtures directly use `tests/http/native-media-seed.js`; transfer
still audits every path rather than accepting an unrelated synthetic drive.
The source sequence retains the seed's bytes through both engines and restart.

`live-tv-sources-native.test.js` starts the designated native application from
a fresh private `currentNativeReference` clone. It never edits or starts the
protected supplied instance. Before the first native startup it replaces the
private LiveTv configuration with empty source lists and explicitly writes
`timers.json` and `seriestimers.json` as empty arrays. Every observation requires
their exact bytes to remain unchanged and their actual JSON to remain empty.
No timer, recording, transcoder or raw stream endpoint is called. Native Guide
still executes its real RefreshSeriesTimers/RefreshTimers with these empty
inputs; it is not replaced by a stub. All task triggers are disabled through the
actual native API before the stopped baseline is captured.

The native public API creates ordinary, denied, management-only and admin
users plus an API key. The test stops native cleanly, transfers that actual
SQLite database and all its user/session relationships to a new PostgreSQL
schema using `transferDatabase`, and runs the real `startProductionInstance`
entry with the persisted transfer/mount contract. This is a production-entry
consumer test, not a claim that this fixture runs the production import/export
CLI round trip. Native and Node execute the same scenario sequentially from
the same rows and source configuration. The source M3U/XMLTV files have shared
absolute identities and an explicit read-only local storage mapping for Node.
Both engines consume those files through their real providers. No route or
provider result is mocked.

The input includes two real M3U channels and two future programmes within the
three-day guide window. One initial channel does not match an XMLTV channel;
the second matches directly. Source mutations must publish a **new** actual
completed Guide task result, not merely observe an earlier idle result. The
test inspects actual persisted channel/program counts and native-identity HTTP
readers after mapping, mapping removal, restoration, tuner filtering and source
deletion. It verifies warm and cold consumers. The original source files,
country bytes, cache sentinel and empty timer bytes are checked after every
request. Native background device scans remain real; they may perform the
native HDHomeRun discovery probe, whose logs are retained. No returned ambient
device is configured or opened by this fixture.

Management coverage includes native controller authorization and JSON/query
binding for POST/DELETE tuner/listing providers, default listings, lineups,
channel mapping/options, raw countries and both Discover/Discvover aliases.
The discovery aliases establish authorization and bad-Boolean binding only.
The test does not pretend an empty network proves implemented discovery.
Repeated mappings remove their existing pair, and a missing tuner mapping
saves configuration and queues Guide before its final lookup fails; these
native failure prefixes are retained. Real source IDs are accepted for
comparison only after 32N format, uniqueness, expected type/path, returned
configuration identity and persisted XML identity checks. Updates must preserve
the chosen identity; case-insensitive deletion removes the actual owned cache.
The non-GUID delete control places a sentinel at the exact private parent path
that `../data/source-sentinel` plus the native `_channels` suffix would otherwise
target; it does not merely watch an unrelated file in the cache directory.

Every observation retains full HTTP bodies, before/after rows for all listed
item/relation/user-data/permission/preference tables, configuration/source/cache
bytes with SHA-256, task settings, and actual task observations. A separate
native process runs the actual MyXmlSerializer/LiveTvOptions and typed
ChannelInfo JSON reader against **captured bytes from both engines**. The
fixture does not infer file compatibility from its own serializer. XMLTV cache
bytes and cache membership compare directly; native/Node channel-cache wire
forms compare through that real typed reader and retain their original bytes.

Only genuine nondeterminism is identified: trace IDs remain nonempty; generated
source IDs use the checks above; new ItemValues IDs are related only after
validating unique actual (Type, Value) identities and every captured foreign
reference. Existing baseline ItemValue IDs remain literal. Creation/save/
refresh timestamps normalize only when their actual ticks fall within that
engine's recorded execution window. Other dates compare exact ticks, and the
programme HTTP UTC dates are checked explicitly. Full raw observations remain
available alongside these comparison projections.

TunerHosts/Types compares the complete native and installed Node inventories,
including the real official HDHomeRun package. Every inventory response retains
the same strict HTTP/body comparison as other requests. Inventory parity does
not establish hardware discovery or raw stream delivery.

The test establishes only the M3U/XMLTV source-management and Guide consumer
slice and complete tuner-type inventory reader. It does not establish successful hardware
discovery, stream delivery, recording, transcoding, production-scale behaviour,
complete CLI migration round trips or final release acceptance.
`phaseAcceptance` and `releaseAcceptance` remain false. Run only in authorized
Actions with native_reference, native_instance and PostgreSQL inputs; no local
verification command is authorized for this slice.
