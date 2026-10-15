# Native RAR directory and selected-stream supplement

`native.json` is an unchanged copy of `comic-rar-path-native-2/native.json`: 30 actual new-build ComicImageProvider and ArchiveFactory observations. `record.json` binds the real build and execution, and `provenance.json` requires the raw records, helper, loaded assemblies, genuine generated inputs, selected streams, per-entry bytes, and pinned SharpCompress source.

The generated inputs are genuine stored RAR4 and RAR5 containers with input-derived checksums and distinct text payloads. They are not ZIP files renamed as RAR, or recordings produced from candidate output. Unmodified upstream RAR archives supply complete six-entry controls. These cases establish directory, key and selected-stream behavior; they do not claim a general RAR writer.

On the recorded Windows native runtime, RAR4 maps forward slashes to backslashes. RAR5 first maps literal backslashes to hyphens, then forward slashes to backslashes. Duplicate names retain their first-match order. A selected directory can return an empty stream. The RAR4 Unicode filename cases exercise literal, shared-high-byte, UTF-16, copy and correction modes, UTF-8 fallback, and malformed input.

The exact upstream FileHeader, async caller, RarEntry, FileNameDecoder and archive encoding sources are pinned by source commit, Git blob and SHA-256. The adapted filename algorithm uses the retained SharpCompress MIT license. Production uses the Node header reader and archive worker; native .NET is oracle-only. Earlier raw recordings and the failing pre-fix Node differential are preserved with explicit qualifications. This supplement does not assert final release acceptance.
