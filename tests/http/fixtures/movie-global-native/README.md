# Current Movie scan input

The capture reads the designated same-run Native source/build and stopped
SQLite input. It prepares one private empty-domain database and shares that
frozen preparation with two independent Native runs and the PostgreSQL
consumer. The real Movie, BoxSet, NFO, XML, probe and post-scan operations keep
their complete persisted rows, files, events and queue boundaries.

The media input is a new Matroska container containing only the unchanged
first MPEG-2 video stream from `tests/fixtures/frozen-av/source.m2ts`.
`tests/helpers/frozen-av.js` records original and copied ffprobe observations,
all selected packet hashes, order and timing, plus the copied container's own
size and SHA-256. No audio/video generation or encoder runs. Cancellation
drains the real copy/probe process before the capture can start a Native run.
The Movie scenario expects that original MPEG-2 stream's 720 by 480 pixels in
all three independently persisted observations.
Generated `fileinfo/streamdetails/video/framerate` is compared as the publisher's
binary32 value and checked against that same item's persisted video stream.
The actual Native and Node NFO readers skip this field. The bound Native source
includes that parser and `MediaStream.ReferenceFrameRate`; decimal spellings
that retain the same rate are equivalent for this consumer. All other XML
content, attributes, namespaces and the original NFO bytes remain preserved.
Historical input bytes, producer and observations remain under their original
identities and do not substitute for these current Native executions.

Run `tests/http/movie-global-native.test.js` only in GitHub Actions on all
three platforms, with Native reference/instance/current SQLite and PostgreSQL
supplied. This bounded scan lifecycle does not establish full-library,
production-scale or release acceptance.
