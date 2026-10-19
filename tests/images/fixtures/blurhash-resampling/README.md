# BlurHash nearest resampling

These ten observations executed the designated source-built runtime and its
actual SkiaSharp and BlurHashSharp libraries. The helper records codec-supported
decode dimensions, unpremultiplied sRGB RGBA, the actual default nearest resize,
and both complete-image and scaled-pixel BlurHash results. Recorded source,
assets, build, libraries and output bytes are bound by `provenance.json`.

The portrait cover exposed the original sampling error: subtracting half a
source pixel moved 8,000 output pixels. Sampling centers with the lower pixel at
an exact source-edge tie matches every recorded RGBA byte, including independent
coordinate PNGs with coprime dimensions. The generated inputs are observations
from actual files, not reconstructions from expected hashes. Gzip copies inflate
to the exact original native RGBA bytes.

The tests compare all ten native decoded-to-scaled pixel buffers and eight
complete PNG/WebP inputs. JPEG `large.jpg` and `wide.jpg` also resize correctly
when given the actual native decoded pixels. Their different codec-supported
initial decode remains unresolved: ordinary Sharp resizing does not produce the
native scaled JPEG decode. They are retained as explicit diagnostic inputs and
are not counted as complete-image JPEG passes.

Original native failures and observations remain outside the repository. The
portable nearest sampler does not call .NET, external image executables or the
native reference server.
