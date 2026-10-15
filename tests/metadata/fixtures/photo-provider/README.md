# Embedded Photo metadata

The unchanged native output executes the source-built Jellyfin PhotoProvider and
its actual TagLibSharp 2.3.0 reader over 56 bound synthetic image assets. There
are 64 Fetch observations and 14 change-monitor observations. The image processor
dimension fallback, directory lookup and filesystem timestamp are controlled;
the fixture does not claim native SQL, full metadata-host or HTTP execution.

Cases cover JPEG/PNG/TIFF/CR2 tags, both TIFF byte orders, EXIF/IPTC/XMP
precedence, PNG text/compressed/international metadata, original Primary image
replacement, Name locks, tag defaults and clearing, all orientations, rational
types and zero denominators, GPS signs/clamping, ISO overflow, capture dates,
100 ns fractions, malformed images, unsupported extensions, fallback failures
and a previously cancelled request token. WebP/AVIF appear in the provider's
allowlist but its pinned TagLib reader rejects them; existing tags survive while
dimensions fall back. Signed EXIF shutter values do not overwrite ShutterSpeed.

DateCreated compares actual UTC ticks. PremiereDate compares native wallclock
ticks, as persisted by the authoritative column; the Node adapter represents
these ticks as Z text. The raw output additionally records DateTime.Kind and the
local timezone. CommunityRating compares the native Single bits and its explicit
double projection, rather than interpreting the shortest Single JSON spelling
as a distinct double. No raw native output is normalized or rewritten.

All assets are newly generated synthetic bytes. The auxiliary TagLib 2.3.0
source archive came from the official mono/taglib-sharp tag and its receipt is
preserved. Required source descriptors are actual reads in the tests; historical
recorder paths in the untouched raw record remain descriptive. Runtime and real
static decoder tests are separate from the controlled fallback observations.

A separate three-case actual PhotoProvider observation proves original Primary
replacement: a file retains the prior BlurHash, while http/HTTP paths clear it
and skip filesystem stat. The unsupported extension and retained positive item
dimensions isolate this boundary without tag, network or decoder reads.

A separate actual PhotoProvider/TagLib observation covers a corrupt mixed-case
Unicode\0 EXIF UserComment marker. Its source JPEG is unchanged; only the
eight-byte marker was replaced with another eight-byte marker, as recorded in
user-comment/asset-patch.json. The original 64-case output remains untouched.
