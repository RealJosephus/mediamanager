# Existing recording directory registration

`Program.cs` invokes the actual `Jellyfin.LiveTv.Recordings.RecordingsManager.CreateRecordingFolders` from the selected native build. Native `Directory.Exists` observes new private directories; the configuration manager and library manager are controlled call consumers. No stream, tuner, encoder, timer, or recording method is invoked.

The dynamic component differential binds `input.json`, the oracle source, and loaded assemblies. It compares directory registration and removal order, complete default library options, configuration mutation and save prefixes, controlled failure continuation, and the unchanged directory tree. This component scope does not prove full HTTP, SQL, scanning, event scheduling, or persisted XML behavior; their consumers require separate evidence.

Reference sources: `D:/jellyfin/src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs`, `D:/jellyfin/Emby.Server.Implementations/IO/ManagedFileSystem.cs`, and `D:/jellyfin/MediaBrowser.Model/Configuration/LibraryOptions.cs` under the project GPL license. Execute only through the authorized CI validation workflow.
