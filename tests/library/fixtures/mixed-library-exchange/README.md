# Mixed Book and Photo exchange

This Actions-only scenario uses two physical libraries in the same production
scan. The designated Native server creates the empty Books and Photos libraries,
using the HTTP-supported `books` and `homevideos` collection options, with
`EnablePhotos=true`, then stops. The creation endpoint accepts
`CollectionTypeOptions`, which does not include the internal `photos` collection
type. Actual `GET /Library/VirtualFolders` responses verify both configured types,
physical locations and Photo/provider/saver switches before the first transfer
and at every subsequent HTTP observation. Every business table is imported into
fresh PostgreSQL. The normal Node entry point resolves two EPUB Books and a JPEG Photo from actual files,
extracts the Book covers, serves both original files and images through HTTP,
favorites a retained Book and deletes the other through HTTP. Its next real
complete scan must preserve the Photo and its actual PhotoAlbum parent.

A fresh PostgreSQL connection and production runtime read the same persisted
items and images. The complete SQLite export preserves all business tables,
raw values, relationship order, EF history and sequence state. The actual
Native HTTP server then reads those Node-created items and bytes, scans an
additional Book and Photo together, and stops. A fresh PostgreSQL schema and
production Node runtime consume all returned values, images and user favorite
state; the removed Book and its file and relationships remain absent.

The EPUB is the existing byte-bound `rich-both-separators.epub` input from
`tests/metadata/fixtures/book-opf-current`. Its existing ZIP entries support both
host separator rules; the source archive is unchanged. The JPEG is the existing
plain 8 by 6 Photo input. `input.json` binds every asset size and SHA-256. Original
inputs are retained in the report as base64. No media encoder or generated
audio/video input runs. Metadata savers and Internet providers are disabled by
the actual library configuration; local Book/Photo providers and the normal
post-scan tasks execute.

The designated Native `/Items/{id}/File` controller uses a loopback proxy on
port 5244. This fixture owns that port and serves only the five declared business
filenames. Each request verifies the actual file size and digest, honors its
real Range request and has no deleted-file fallback. Node reads through its
normal local storage plugin and VFS. Every file and image response retains its
complete HTTP bytes in the report. Original files and
Range responses are byte-exact, as are the extracted PNG Book covers. Photo
previews request lossless PNG and compare the complete decoded sRGB RGBA bytes
and dimensions with the declared JPEG input. This verifies the actual item's
displayed content without assuming that a Photo preview retains the source
JPEG container or that both runtimes choose identical PNG encoding bytes.
The common source and instance directory is private;
only filtered reports and actual process logs are published after every owner
closes. Resource leases cover the proxy and actual discovery through cleanup.

Select `tests/library/mixed-library-exchange.test.js` in GitHub Actions on all
three platforms with `native_reference=true`, `native_instance=true` and isolated
PostgreSQL supplied. This is a bounded multi-type production scan/HTTP/exchange
consumer. It does not establish owned video extras, versions, arbitrary combined
topologies, a full production instance, production scale or release acceptance.
