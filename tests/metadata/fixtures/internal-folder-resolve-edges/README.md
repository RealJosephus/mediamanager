# Native internal resolve edge controls

Forty-eight controls invoke actual resolve/refresh hooks for AggregateFolder and CollectionFolder after an initial EF save. They cover UTF-8 with/without BOM, UTF-16 LE/BE and UTF-32 LE/BE shortcuts containing Unicode and a supplementary character, explicit NULL physical lists, refresh-flag short circuits, null/empty/NUL paths, missing roots and file-valued roots. Captures exception classes/parameter names and live cache/flag/list state; full exception messages are outside the projection. Physical-root children, parents, collections, configuration and path expansion remain controlled.

The native string-array SequenceEqual overload treats NULL physical locations as an empty span. The PhysicalFolderIds comparison against a List uses the enumerable overload and reports ArgumentNullException(first). AggregateFolder clears IDs before path validation, including on failure. DirectoryService turns missing directories into empty entries; enumerating a regular file throws IOException.

The original recorder remains candidateVerified=false. The candidate replays the declared projection through actual context/hooks and SQLite/real PostgreSQL. These controls do not establish full JSON/scalar bytes, complete physical-media resolution, network snapshots, ValidateChildren, production monitor/post-scan tasks or complete-library/release acceptance.
