# Native internal directory resolve arguments

Forty-eight controls invoke actual AggregateFolder/CollectionFolder CreateResolveArgs, FileData, MbLinkShortcutHandler, CoreAppHost expansion and NormalizeRootPathList on isolated instance directories. Captures raw shortcut locations, ordered child metadata, directory existence, flags and set-location behavior. Duplicate/raw/mixed separator/case/newline/URL locations are retained where the native method retains them. AggregateFolder flattens two directory levels; CollectionFolder does not flatten. Parents, collections, configuration and physical-root children remain controls.

The candidate keeps instance root/data/metadata access local and maps synthetic media shortcut targets into Memory VFS explicitly. It does not broaden host media access. Directory metadata normalization is separate from the raw PhysicalLocations list.

The original recorder remains candidateVerified=false. The candidate replays the declared projection through actual context/hooks and SQLite/real PostgreSQL. These controls do not establish full JSON/scalar bytes, complete physical-media resolution, network snapshots, ValidateChildren, production monitor/post-scan tasks or complete-library/release acceptance.
