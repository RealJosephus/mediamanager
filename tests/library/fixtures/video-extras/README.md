# Native video-extra naming and classification

The oracle calls the frozen Jellyfin DLL's actual `ExtraResolver.TryGetExtraTypeForOwner`, `ExtraRuleResolver`, and `VideoResolver` over direct suffixes, exact filenames, typed extra directories, years, and version-like prefixes. It records validity, `ExtraType`, matching rule, cleaned name/year, and the concrete resolver selected for video extras. `native.json` is the portable LF projection of the successful raw recording; `provenance.json` pins its bytes, the input/project, seven frozen source files, and the actually loaded assemblies. The original CRLF recording digest is retained separately.

This fixture does not execute `LibraryManager.FindExtras`, localization/numbering, file-system enumeration, version-owner selection, database persistence, or a native library scan. Those contracts require separate source-bound and end-to-end evidence.
