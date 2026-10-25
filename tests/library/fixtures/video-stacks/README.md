# Native file-stack resolution

The oracle calls the frozen Jellyfin DLL's actual `MovieResolver.ResolveMultiple`, `VideoListResolver`, `StackResolver`, and `VideoResolver` over movie and home-video file lists. It records primary selection, ordinal path order, raw stack boundaries, per-file parsing, item naming, additional-part arrays, ordinary-version interaction, and extra handoff. `native.json` is the portable LF projection of the successful raw recording; `provenance.json` pins its bytes, the recorder inputs, five frozen source files, and the actually loaded assemblies. The original CRLF recording digest is retained separately.

This fixture does not execute directory-stack resolution, the native library scanner, owned-part refresh or persistence, deletion, metadata/provider/image inheritance, or complete library acceptance. Those contracts require separate source-bound and end-to-end evidence.

