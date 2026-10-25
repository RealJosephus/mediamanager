# Official Emby user copy observations

`reference.json` contains unchanged selected HTTP request/response records and
target WebSocket frames from the isolated official Emby 4.10.1.0 server in
[run 39462156852](https://github.com/RealJosephus/mediamanager/actions/runs/39462156852).
The full observations hash, original release archive hash, capture producer,
commit, package/runtime stability and cleanup are recorded alongside them.
The original complete receipt and logs remain in the run artifact. No server
binaries or credentials are redistributed here.

Three real scanned PCM WAV items distinguish source data, overlapping target
data and a target-only item. Configuration copy replaces the target settings
dictionary and retains identity. Playback data copy overwrites overlaps and
retains target-only data. Configuration and policy copy send their distinct
Emby message types; playback copy produces no new target message in the
recorded window. Unknown and empty options return 204; a missing target returns
the captured 500 response.

The Node consumer checks these copy behaviors, current configuration and raw
settings, all native playback columns and keys, SQL execution, protocol-specific
messages and restart persistence. It does not claim complete Emby UserDto,
HomeSections, search-history or client UI compatibility.
