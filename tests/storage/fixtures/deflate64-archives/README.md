# Actual ZIP/Deflate64 reader observations

`native.json` is the unmodified structured output from the designated .NET
10.0.12 `ZipArchive`/`ZipFile` implementation. The oracle opens every entry and
records entry-open separately from entry-read, including the exact exception
type and message. It executes no Jellyfin server, Book provider, SQL or Node
decoder. The actual Jellyfin source/build pins establish which Book consumers
use this runtime reader; they are not claimed as executed provider observations.

The recording contains 30 entries: six entries from the unmodified upstream
`Zip.deflate64.zip`, 17 independently encoded Deflate64 boundary entries, and
seven identical valid Deflate payloads under method headers 8/9/12/14/93/95/98.
Methods 8/9 read successfully. The other five fail at `entry.Open()` with
`System.IO.InvalidDataException` explicitly reporting an unsupported method;
they never reach payload decoding. A generic invalid-data exception during
reading would not establish compression admission.

`generate.mjs` imports no production decoder. Its independent bit encoder
constructs stored/fixed/dynamic blocks, all fixed literals, maximum stored
length, code 285 with 16 extra bits (lengths 3/258/259/65538), distances
32768/32769/49152/49153/65535/65536, repeated history-window wrap, dynamic
code-length repeats 16/17/18, and five block transitions. The native receipt
checks every intended generated plaintext length/hash against real .NET reads.
Permanent expected hashes come from those native reads.

The upstream asset is from SharpCompress commit
`c083c6efd843a844b0c8f7878787360e815be781` at
`tests/TestArchives/Archives/Zip.deflate64.zip`. Its Git blob SHA1 is
`2c2e89050361492e81b3404258348bf0a742c853`; SHA256 is
`f5c77a3014606c711777e8e683b97816a90171aedbacb54dc381fa1cacc0248f`.
`LICENSE-SharpCompress.txt` is the unmodified MIT license from the same commit.
The byte and license pins were independently checked against that Git tree.

The final recording is
`D:/mediamanager-validation/20261016-book-stage/results/deflate64-native-3/`.
`before-pins.json` predates compilation/execution and binds source helpers,
actual original/captured Jellyfin sources, the new build/DLL identity, actual
runtime assemblies, package metadata, upstream Git tree/asset/license and all
input ZIP bytes. Earlier exploratory admission observations are superseded by
this single complete run. No previous evidence was overwritten.

The Node test exercises real `BookArchiveService`, its original-media identity
mapping, actual worker and production decoder, compares every successful
entry's bytes by length/SHA256, checks intentional ZIP-only admission failures,
and confirms spool cleanup. Its VFS seam supplies the pinned archive byte
streams; it does not claim a native server or native storage implementation.
