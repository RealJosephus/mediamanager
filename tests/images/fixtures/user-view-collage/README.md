# UserView thumbnail renderer

The unchanged `native.json` and PNG files were recorded by the actual
`SkiaEncoder.CreateImageCollage` and `StripCollageBuilder` in the designated
Jellyfin workspace's newly bound build. The helper creates isolated static
image inputs and supplies application paths; it does not open media or ports.
Source, helper, build, execution and file digests are in `provenance.json`.

The candidate renderer uses the existing bitmap decoder and resize renderer.
The runtime provider retains its explicit unsupported collage branch. The
renderer and save pipeline are reachable only through explicit composition
injection until the complete image contract is verified.
The exact-pixel tests cover unscaled, downscaled, wide, alpha, skipped invalid,
empty and invalid-only inputs. Output is a 960 by 540 PNG; invalid-only input
produces opaque black. Directory and GIF errors propagate before image saving.

**Unresolved:** upscaled bitmap colors differ by one in some RGB channels;
text placement and rasterization differ from native Skia shaping, including
Latin and fallback fonts. These are unaccepted differences, not tolerances or
passing native comparisons. All raw native cases remain available for repair.
The current tests deliberately claim only the exact cases named above and
decoder boundaries. They do not establish complete collage, platform, provider,
ImageSaver, SQL, HTTP, or release acceptance.

Layout and image selection are derived from GPL Jellyfin sources listed in
the provenance file. No audio/video extraction or generated media is involved.
