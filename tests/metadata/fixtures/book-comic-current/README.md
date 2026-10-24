# Current Comic metadata and saved-image consumers

The current consumers execute the designated source build twice in independent
directories. The complete original 103 metadata scenarios and 44 archive-cover
scenarios remain in `input.json`; upstream archive paths are explicit relative
asset names. The ten original SharpCompress archives and its MIT license were
recovered from their original fixed commit and match the original length and
SHA-256 pins. `assets.json` records each URL and Git blob identity.

The metadata oracle executes the real ComicBookInfo, external/internal
ComicInfo and composite providers. Candidate tests read the newly generated
archive inputs through the production media VFS and independently mapped
metadata sidecars. They compare metadata values, people, provider precedence,
change checks, failure outcomes, selected stream format/length/hash and actual
archive cleanup. Error names, messages and log records remain raw diagnostics.

The image-consumer oracle repeats all six original normal, solid and encrypted
RAR local/internal saves using actual ItemImageProvider, ProviderManager,
ImageSaver, LibraryManager, ImageProcessor/Skia and SQLite persistence. Each
process loads its own supplied-platform SQLite and Skia libraries. Their actual
loaded copies are bound to the same-run runtime payload. Saved file hashes,
paths and image rows are retained. The existing PostgreSQL Book runtime cases
consume these fresh selected streams and verify persisted image values and
source preservation. The EPUB runtime case uses the existing current OPF/EPUB
capture and its exact tracked archive input.

`../book-comic/current-profile.json` binds the current oracle sources, projects,
assets, build properties, shipped codec payload, reviewed codec source/patches
and full license bundle. `../book-runtime-current/current-profile.json` also
binds all inputs actually executed by the OPF/EPUB capture. Current capture
reports retain source-offer/build bindings, execution records, raw observations
and per-case candidate results. Historical recordings and provenance remain
unchanged. These are component and focused runtime consumers; complete server
takeover, full instance exchange and release acceptance are separate scopes.
