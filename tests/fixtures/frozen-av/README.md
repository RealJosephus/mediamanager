# Frozen audio and video inputs

`source.m2ts` is the unchanged 110,592-byte controlled input from the
`windows-2025` artifact of Actions run `40162626589`, candidate
`a16d687edd7b212f3a752f99a9dda6919fd1c0f4`. SHA-256:
`719919ca910fdaf4b035d2dac56cdbb4c95efe7c5a465f93303901e8b747f027`.
The original ZIP member, archive identity, original producer Git blob and every
copied file identity are in `input.json`.

`dual-avc.m2ts` is the unchanged 92,160-byte dual AVC and AC-3 input from the
same artifact. SHA-256:
`39c02b66aa2fe6d4f6fd7b4e13a8bda304774919db06c60b9001d096198c99d1`.
Its original generation receipt, PMT declaration, native observations, recording
receipts and probe outputs with and without SSIF are retained unchanged.

The original producer source and repository license accompany the original
generation receipt, native observations, recording receipt and probe output.
These files preserve the historical operation as evidence. Current consumers
never execute that producer or its generation command. This packaging does not
recreate the historical runtime or certify a new native execution.

The MPEG-2 input has 720 by 480 video pixels and stereo AC-3 audio.
Tests may read the original transport unchanged or copy its first video stream
and optional first audio stream to an explicitly selected Matroska, VOB or MP4
container. An optional FFMETADATA input changes tags and chapters only. Current
preparation stores the complete ffprobe observations and verifies packet payload
hashes, order and timing before using a copied container. Timing comparisons use
the original and copied stream time bases, allowing their actual timestamp
resolution while preserving the shared video reference and audio synchronization.
Container timestamps and bytes have their own current identity. No audio or
video encoder is selected.
