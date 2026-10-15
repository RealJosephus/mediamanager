# Artist creation observations

The recording calls the designated LibraryManager.GetArtist against its actual
BaseItemRepository and EF SQLite persistence. All 72 mapped columns before and
after each action are independent inputs and observations. It verifies physical
artist preference, raw name selection, by-name identity reuse, replacement,
Unicode names, ID settings, directory timestamps, save/Added ordering, retries,
file targets and persistence failures. Lookup does not refresh metadata.

Program.cs and Oracle.csproj are the original recording sources. The native.json
bytes, designated source files, actual assemblies and runtime are bound by
provenance.json. Recording controls configure the host paths and virtual path
mapping, filesystem and media-source interfaces; no media or port is opened.
The build input closure remains incomplete. Candidate PostgreSQL tests add real
save failure/retry and metadata-root junction checks. These observations do not
cover the complete metadata provider, HTTP authentication or client lifecycle.
