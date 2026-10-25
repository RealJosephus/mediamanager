# Frozen VobSub delivery inputs

`native-http.json`, `input.json`, and `source.mkv` are byte-for-byte copies of the isolated frozen-server HTTP recording from `2026-09-27`, including the four-stream composite MKV (SHA-256 `4a9a6e3be221f0d08506ca6bbd6d3ad73819c82605871e9fd981b7bf14399a6c`). The original native advertisement ends in `.vobsub` and returns HTTP 400 with `Error processing request.`. A manual `.mks` request returns HTTP 200 and the recorded subtitle packets.

`native-dll.json` is the unchanged output of the actual frozen SubtitleEncoder, SubtitleEditParser, StreamBuilder and StreamInfo assemblies from the later isolated audit. It records six profile selections and advertisement suffixes, both rejected codec suffixes, and successful `mks`/`MKS` cache reads. The cache was supplied independently; this DLL audit did not execute ffmpeg or prove HTTP transport. The earlier HTTP recording supplies that separate evidence.

Tests verify input SHA-256 values before use. Matroska container bytes may differ between the native seekable output and the candidate pipe; codec properties, packet timestamps and packet bytes are compared. These fixtures do not prove real client presentation or complete subtitle compatibility.
