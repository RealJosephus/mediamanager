# Native internal folder metadata services

Fifty-three controls invoke the actual FolderMetadataService for four internal folder types, actual filesystem metadata/path reversal and EF saves. ProviderManager has empty provider/image/saver registries. Parent/collection/options/root-children lookup, fallback FindByPath and reattachment callback remain controlled. Captures update flags, ordered save/reattach calls, names, virtual stored paths, Data nullness, physical arrays and refresh timestamps. Complete JSON is deliberately excluded.

The metadata service does not assign resolved PhysicalLocationsList or PhysicalFolderIds; those updates belong to other lifecycle hooks. PlaylistsFolder stores NULL Data. The candidate uses actual production context and metadata host on SQLite/real PostgreSQL with the corresponding empty registry.

The original recorder remains candidateVerified=false. The candidate replays the declared projection through actual context/hooks and SQLite/real PostgreSQL. These controls do not establish full JSON/scalar bytes, complete physical-media resolution, network snapshots, ValidateChildren, production monitor/post-scan tasks or complete-library/release acceptance.
