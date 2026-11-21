# Guide refresh orchestration fixture

The Native oracle invokes the designated DLL's public GuideManager.RefreshGuide. It runs the real channel/program selection, guide-day clamp, per-service and per-channel error handling, progress, pre-cache and stale-data decisions. LiveTvDtoService obtains identities from LibraryManager.GetNewItemId, and durable frames use the actual BaseItemMapper. [Oracle](Program.cs) · [Inputs](input.json)

The Native fixture supplies controlled Live TV services, scanner, recording-folder coordinator, repository and metadata provider. Existing programs are independently hydrated from in-memory frames before the dictionary check. Writes retain the last row for an ID and cascade parent deletion. The fixture supplies local image identity and file metadata. Its ILiveTvService proxies expose channel and program reads, so the final DefaultLiveTvService filter finds no services.

On the Node side, LiveTvGuideService uses real PostgreSQL cohorts, program batches, image handling, metadata refresh and ItemDeletionService. A plugin-backed state filesystem and mapped media namespace supply the PNG. Its SHA must survive refresh and shutdown. Duplicate GUID spellings stay separate until the production dictionary rejects them.

| Comparison | Recorded behavior |
| --- | --- |
| Order and identity | Capture folder setup, scan, service enumeration, channels, configuration, program lookup, new and updated batches, pre-cache, channel refresh and global cleanup. Compare selected typed snapshots in order. Only the controlled parent is mapped to a common identity. Extra writes inside Node metadata processing remain in the SQL evidence. |
| Windows and progress | Program dates are in year 2500. Each provider window starts one hour before an instant within the call and spans the clamped guide days. Pre-cache executes with zero download workers. Both progress sequences are retained. The fixture waits for the declared callback count and compares value multisets to ten decimal places because Native dispatches inner callbacks asynchronously. |
| Errors and cleanup | Cases include multiple or zero services, failed channel creation, continuation after a failed service, 130 valid programs followed by null genres, duplicate GUIDs, stale cleanup suppression, repeated empty selections and pre-cancellation. Check committed prefixes, empty TEMP/admission state, closed schema and adapters, and the original stopped-instance identity. |

Image downloading and DVR execution have their own consumers. [Guide image fixture](../live-tv-guide-images/README.md) · [Recording fixture](../../../playback/live-tv-dvr-native.test.js)
