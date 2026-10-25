# Book OPF and EPUB

The unchanged native recording executes actual OpfReader, OpfProvider,
EpubProvider, EpubImageProvider, ManagedFileSystem and .NET ZipArchive from the
new source-built Jellyfin DLL. It contains 68 reader, 13 sidecar-provider,
38 EPUB metadata/cover and five ZIP entry observations. Logger collection and
the application temporary-directory property are controlled. This does not
claim native generic metadata-host, SQL, HTTP, scanning or release acceptance.

All XML and ZIP bytes are synthetic. The embedded cover is the separately
generated Photo-stage 8x6 PNG, copied here as an independent byte-bound asset.
The raw recording binds every asset SHA. Exact ZIP keys are significant:
on this Windows build META-INF\container.xml is matched; the usual forward
slash spelling is not. Cover paths retain literal separators and dot segments.
The successful rich-with-cover EPUB supplies realistic metadata and image
bytes for separate runtime integration.

Cases cover namespaces, title/sort refinements, mixed text, creator roles and
initials, IDs, genres, Calibre rounding and errors, dates/ticks, encoded XML,
DTD/entity handling, literal CR/CRLF and whitespace, file/directory/missing
selection, exact timestamp thresholds, locked reads, cancellation, cover
priority/MIME mapping and archive name/duplicate rules. Null/empty fields are
compared as consumer values. Invalid UTF-16 values from numeric XML references
compare using the existing wire string normalization, not CLR representation.
PremiereDate compares wallclock ticks stored in the authoritative SQL column.
CommunityRating compares the native Single's explicit double projection.

Node provider tests use the production archive reader over these real ZIP
bytes through scoped VFS media access. Separate controlled seams verify
cancellation/error prefixes and closure; they are labeled separately.
The source reads and assembly bytes actually checked by tests are required
hash inputs. Old failed and successful development recordings remain outside
this fixture and are not rewritten.
