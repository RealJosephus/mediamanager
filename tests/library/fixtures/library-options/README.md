# Native library options persistence

The neutral `input.json` exercises the loaded `CollectionFolder.GetLibraryOptions`, `SaveLibraryOptions`, `OnCollectionFolderChange`, `JsonDefaults` clone, and `MyXmlSerializer` over real isolated files. The application host's forward/reverse path substitution is controlled. The native store, constructor defaults, XML, cache references, update events, read-only failures and serialization failure prefixes execute without a candidate implementation.

The candidate compares complete live, cached, disk and reopened values and the order of path substitution/update events. XML layout is read semantically under R23; failure presence and commit prefixes are compared without requiring CLR exception labels. Original XML bytes remain in the native recording. New candidate files are saved under the isolated validation output for native consumer reading.

This fixture does not exercise `LibraryManager.AddVirtualFolder`, top-level scanning, metadata refresh, PostgreSQL transactions, watcher behavior, HTTP model binding or either Web client. `candidateVerified:false`, `completeBuildInputClosure:false` and `phaseAcceptance:false` describe the recording boundary and must not be promoted by a unit-test pass. Jellyfin sources are GPL-2.0; exact source, isolated build-copy, runtime, oracle project and loaded assembly identities are bound in `provenance.json`.

To reproduce, supply the isolated `MEDIAMANAGER_JELLYFIN_DLL` and matching `MEDIAMANAGER_DOTNET`, then run `tools/validation/oracle.js` with this project and a fresh output directory. Pass this input file, a new state directory, and the native JSON destination as its three arguments.
