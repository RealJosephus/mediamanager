# Retained live stream components

The Native oracle seeds the real MediaSourceManager dictionary with controlled ILiveStream objects. It checks case-insensitive public and unique IDs, null/empty inputs, misses and the IDirectStreamProvider cast. The controlled input is already open. [Oracle](Program.cs) · [Comparison](../../live-stream-retained-native.test.js)

| Boundary | Observable result |
| --- | --- |
| Native delivery | LiveTvController.GetLiveStreamFile returns a FileStreamResult that runs through the MVC executor over an observed MemoryStream. ProgressiveFileStream is nonseekable. The default 30,000 ms timeout is preserved. Reaching EOF cancels the controlled request and retains the response up to cancellation. A separate zero-timeout read exercises EOF. |
| Node delivery | LiveStreamsService, PlaybackService.liveStreamFile and BinaryResult write to a real Writable with backpressure. Discovery, tuner leases and probe results are controlled. Each retained reader is independent of the public owner iterator. |
| Shared assertions | Compare status, content metadata, byte count and SHA-256 across containers and identity spellings. HEAD disposes an unread reader, Range is disabled, explicit cancellation stops after three bytes, and the manager closes its input once. Read counts and cancellation diagnostics are retained per implementation. |
| Native file offsets | A prepared file backs the base LiveStream.GetStream. Fresh readers start at zero. After ten seconds a reader tries the last 20,000 bytes, and a short file stays at zero. A missing file produces 404. |

The offset case measures a prepared Native file. The playback and DVR fixture exercises a growing tuner input, late readers and cleanup through HTTP. [Live playback test](../../live-tv-dvr-native.test.js)
