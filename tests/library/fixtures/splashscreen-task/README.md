# Splashscreen post-scan task

The 14 observations invoke the designated `SplashscreenPostScanTask` assembly. Repository item selection and static image encoding are explicit controls. `input.json`, `native.json`, `Program.cs`, `Oracle.csproj`, and `provenance.json` retain the producer's raw bytes.

Cases cover empty inputs, poster-only inputs, Thumb preference, Backdrop fallback, first-image-only selection, null/empty/whitespace paths, duplicates, input order, query and encoder failures, initial cancellation, and progress-observer failures. The native task does not inspect its token or report progress. It calls the encoder even with empty path lists.

The separate `splashscreen-query` fixture exercises the real repository and SQLite. The image fixture exercises the actual Skia encoder and builder. This controlled task recording alone proves neither of those boundaries nor a complete Jellyfin build closure.
