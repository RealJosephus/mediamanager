# Current image BlurHash consumers

The input retains all ten original images with identical bytes. Two independent invocations use this run's designated native BlurHashSharp and SkiaSharp libraries. They retain the complete image BlurHash, codec-supported decode dimensions, nearest resize and normalized RGBA pixels. Row strides remain diagnostics; exported pixel buffers contain consecutive RGBA rows.

The JavaScript tests compare every nearest resize's resulting BlurHash, then exercise the actual image processor for all ten images. JPEG complete-image checks are included explicitly. Full decoded/scaled RGBA, raw SHA and per-channel pixel differences remain diagnostics; internal buffers and unconsumed Alpha do not independently gate acceptance. The older recording covered only eight complete PNG/WebP inputs; its two unresolved JPEG inputs and old compiler/runtime provenance remain unchanged. JPEG diagnostic variants retain actual decoded/scaled buffers and final hashes to identify a functional decoder issue without treating a timeout or a partial result as success.

The current manifest binds actual image bytes, the unchanged BlurHashSharp license, oracle inputs and designated source paths. Loaded managed and native libraries bind to this run's supplied runtime. This does not reproduce old DLLs, compiler objects, experiments or image HTTP/storage transactions.

JPEG pixel decoding uses a new Actions-built portable libjpeg-turbo/skcms module.
Its source offer, complete library archives, standard-library/JavaScript runtime
sources, licenses and untouched build receipt are bound by the current manifest.
The test retains both original JPEG decoded RGBA buffers in full and strictly
compares complete ten-image BlurHashes and public image dimensions. Actual
bad-input, cancellation, recovery and owner-close paths are exercised without
exposing arbitrary filesystem access to media.
