# Current PhotoAlbum cover consumers

`photo-album-provider.test.js` runs this 41-case input against two independent
executions of the supplied designated Native build. It exercises the actual
PhotoAlbum/BaseFolder/BaseDynamic image providers, the SQLite EF repository,
LibraryManager ancestor normalization, and ProviderManager/ImageSaver file save.
Application, configuration, library dispatch, image processor and injected
failure seams remain controlled interfaces; this fixture is component evidence.

`current-profile.json` binds the input, helper, project, build properties, PNG and
JPEG bytes. `capture.js` verifies the same-run source offer/build/runtime, actual
loaded assemblies and the SQLite binary for the current SDK RID. Each execution
retains its raw output and receipts in a new external validation directory. The
historical `photo-album-cover` and `photo-album-cover-paths` recordings and
provenance remain unchanged and are not inputs to this consumer.

The matrix covers recursive ancestor selection, file/folder priority, owned and
alternate rows, zero GUID references, image ordering, extension/MIME handling,
protected external and remote covers, timestamps/missing files, separator and
dot-segment boundaries, cancellation, save/deletion failures and temporary file
cleanup. Path construction uses each host's actual separators and compares that
host's observed behavior. Error details are retained as diagnostics; failure,
selected identities, image metadata, file bytes and committed prefixes are
compared.

Node uses fresh PostgreSQL schemas seeded from the current Native row snapshots.
Additional cases cover 20,000 descendants with bounded SQL selection, independent
media/metadata mappings, image persistence and original HTTP bytes/MIME, deletion
before an image insert failure, and partial runtime configuration. Candidate
observations for every differential case are retained beside the Native runs.
These checks do not claim a complete Native server or production instance
exchange.
