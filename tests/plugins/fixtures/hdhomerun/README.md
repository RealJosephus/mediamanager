# HDHomeRun tuner fixture

The component test activates installed and preinstalled HDHomeRun packages through PluginHost and a mapped local cache. On the Native side it calls the designated Jellyfin HDHomeRun, BaseTunerHost and SocketFactory implementations in a worker. The report binds source files, assembly and input hashes to actual HTTP requests, UDP packets, cache bytes and returned source descriptors. The reference code is covered by GPL-2.0-only. [Component test](../../hdhomerun.test.js) · [Native oracle](Program.cs)

## Discovery and cache

- Native sends its 20-byte discovery request to the default limited broadcast on UDP 65001. For every captured request the fixture sends a short packet, a wrong-kind packet and two valid replies. Node receives all four. Native produces two device/HTTP observations. Each phase binds requests to its actual socket port, compares ordered results including duplicates and drains callbacks before the next phase. This accounts for repeated broadcast delivery on macOS. Failed sends, late packets and socket cleanup remain visible in the report.
- Controlled HTTP model and lineup responses exercise property casing, duplicate keys, numeric booleans, quoted Int32 values, nulls, HTTP errors, favorite/DRM filters and first-host precedence. Validation can update the device ID and clear the model cache while retaining the channel cache.
- Cache comparisons cover memory hits, forced refresh, cold fallback and a shorter OpenOrCreate write that leaves an invalid suffix. A fresh Native reader consumes a cache written by the installed Node package after an HTTP 503. Host IDs `.` and `..` produce `._channels` and `.._channels` inside the cache root. Node rejects path separators, colons and NUL in a cache identity.

## Device profiles and streams

The Native stream factory constructs modern SharedHttpStream and legacy HdHomerunUdpStream objects. The fixture inspects the original stream ID, source, protocol, sharing flag, tuner identity and initial consumer count before disposal. Source-list comparisons cover the producer fields and stream defaults for each advertised profile. For an HDTC tuner with hardware transcoding enabled, the list includes six device profiles and the native source. A separate construction case checks the `internet360` HTTP URL. [Provider](../../../../plugins/hdhomerun/tuner.js) · [Profile definitions](../../../../plugins/hdhomerun/source.js)

Node HTTP cases check first-byte readiness, empty EOF, non-success response bodies, tuner capacity, mismatch rejection, retained readers, cancellation and last-owner cleanup. Playback comparisons use a separate loopback device that serves modern profile URLs and accepts legacy TCP tune/lock commands, sends RTP and observes lock release. Use that fixture to trace bytes from the tuner through the playback service. [Playback comparison](../../../playback/hdhomerun-device-native.test.js)
