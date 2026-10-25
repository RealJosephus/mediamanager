# Existing FLAC packet-copy input

`assets/upstream/subset/60 - mono audio.flac` is the original 47,782-byte IETF CELLAR FLAC test file at commit `aa7b0c6cf32994c106ae517a08134c28a96ff5b2`, tree `b67c4b7737bc8157137757249e4e8ec49429bab0`, Git blob `9ca8a6721a5e9192ec74d97c61d7c57ce80379f0`. SHA256: `20539fbbd6ae28cea2b2182a4c60c6c70cbb710a136199fc83200c4e5fa00b1c`.

The upstream repository's LICENSE and root/subset READMEs accompany the original asset. The upstream README dedicates all files to CC0. Original GitHub API responses, Git blob metadata, the original preparation index and its byte descriptors are retained under `assets/`. They describe source preparation, not media execution. The local attributes retain all asset and upstream text bytes with `-text`; ordinary fixture source checkout line endings are instead bound by actual same-run descriptors.

This independent current fixture reads the original file. Native MediaEncoder performs real original-input probing and StreamBuilder performs complete audio selection with an explicit no-encoding support boundary. Selected audio-only MP4 progressive and fMP4 HLS command builders then execute actual packet copy. DynamicHlsHelper reads the actual copied audio state to produce its manifest codec value. A separate apphost admits version/read-only original probing and explicit copy codecs only. It rejects unknown capability, filter, hardware, synthetic-input and A/V encoding operations before forwarding. It does not implement recording.

Native command execution and independent repeat are distinct from formal Node HTTP/runtime/Local/VFS/PostgreSQL/cold consumers. The Native raw-input HTTP server is controlled; this is not a complete Native HTTP server or a full device/codec matrix. Raw ffprobe streams, packets, data hashes and timing are retained for the original, Native copies, repeated copies and Node HTTP payloads. Concatenating an HLS initialization and its original fragment bytes only reconstructs that copied container for read-only probing. No audio/video payload is generated or re-encoded.

Only the measured FLAC audio-only MP4 branches can be admitted. This fixture supplies no Opus, DTS, TrueHD, video+FLAC, hardware, audio/video generation, recording, Web-client or release acceptance.

The actual Native progressive command includes `-acodec copy -ar 44100`.
The copy codec keeps the compressed audio packets; the sample-rate option does
not invoke a resampler in that branch. The wrapper admits this command under
the same explicit-copy requirement, and the complete output packet payloads
and rational timing must still match the original FLAC.

The formal Node runtime receives the wrapper control variable through its
top-level `environment` input. The shared MediaEncoder owner passes that same
environment to version discovery, original probing and packet copy. A nested
encoder-options environment does not replace the runtime environment.

Device-profile negotiation uses an explicitly created PostgreSQL playback
user. PlaybackInfo POST bodies carry that UserId while the real API key
authorizes the requests; a userless key alone is not a playback user.

Public observations replace any API key in text/JSON playback URLs with its
SHA-256, including encoded response observations, while retaining the original
body length and digest. Actual requests and media comparisons use the original
bytes. Audio/container payloads and packet observations remain unchanged.
