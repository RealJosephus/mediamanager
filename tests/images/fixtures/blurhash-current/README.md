# Current image BlurHash consumers

The input retains all ten original images with identical bytes. Two independent invocations use this run's designated native BlurHashSharp and SkiaSharp libraries. They retain the complete image BlurHash, codec-supported decode dimensions, nearest resize and normalized RGBA pixels. Row strides remain diagnostics; exported pixel buffers contain consecutive RGBA rows.

The JavaScript tests compare every nearest resize and its resulting BlurHash, then exercise the actual image processor for all ten images. JPEG complete-image checks are included explicitly. The older recording covered only eight complete PNG/WebP inputs; its two unresolved JPEG inputs and old compiler/runtime provenance remain unchanged. JPEG diagnostic variants retain actual decoded/scaled buffers and final hashes to identify a functional decoder issue without treating a timeout or a partial result as success.

The current manifest binds actual image bytes, the unchanged BlurHashSharp license, oracle inputs and designated source paths. Loaded managed and native libraries bind to this run's supplied runtime. This does not reproduce old DLLs, compiler objects, experiments or image HTTP/storage transactions.
