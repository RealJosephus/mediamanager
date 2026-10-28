# Client log HTTP and real instance files

`client-log-native.test.js` starts the designated same-run Native clone, creates
an ordinary user and API key through the real public endpoints, and runs the
declared request matrix. After normal Native shutdown, all native SQLite tables
are imported into an isolated PG schema and the same instance starts through
the production Node entry. Both use their actual token/device/key records.
The explicit stopped origin binds the complete SQLite file, DeviceId and
system/network configuration bytes. It is not a portable whole-instance state
package: Native may create valid POSIX log filenames containing Windows path
characters during the platform-leaf cases. Every such log remains present and
its complete bytes are checked without weakening the portable generation gate.

The matrix covers the disabled gate and authorization order, ordinary and API
key principals, empty and binary bytes, opaque malformed JSON, exactly 1,000,000
bytes, header-only declared oversize requests, culture and Accept negotiation,
platform path leaves, trailing separators, dot leaves, URL-decoded Unicode, a
decoded NUL, and a successful upload after rejected requests. Authentication
field values follow the existing percent-encoded MediaBrowser header protocol.
All payloads are generated CI log data, unrelated to media generation or user
production logs.

The inherited `BaseJellyfinApiController.Produces` declares JSON output formats.
The declared-length 413 therefore returns a JSON string even for an
`Accept: text/plain` request; its localized number, exact body and content type
remain compared. This endpoint constraint does not change shared negotiation.

Every successful response must identify exactly its newly created file. The
file name's client/version leaves, UTC second interval and fresh N-form UUID
are checked before replacing that response's own `FileName` role for comparison.
Every actual file is read completely and compared byte-for-byte; full file bytes
and original HTTP bodies/headers stay in the report. Independent random names
are never paired through a directory-wide normalization. Rejected headers and
permissions must create no upload file.

Real partial HTTP uploads exercise disconnect and subsequent recovery on both
servers. Before sending a partial body, the client waits for its own actual
upload file to be created. A positive file-size observation then proves a real
write while the request is still active; a closed, destroyed, failed or already
responded request cannot satisfy this handshake. The client actively disconnects
and still requires every submitted partial byte in the final closed file before
checking the subsequent successful write. The first run's timeout-induced file
flush is not treated as an in-flight write witness.

The real rejected chunked request submits all 1,000,001 original bytes: a
1,000,000-byte B prefix followed by one C overflow byte, using exactly two client
writes. The first write is 65,536 bytes. The second write waits for a positive
file-size observation while this request is still active, with no response,
error, close or destruction. The observed visible size is retained; it does not
require an open FileStream to flush its entire buffer. Client writes do not
define TCP or server read boundaries.

After each complete 500 response, the entire retained file is read and preserved.
It must contain at least its own genuinely observed visible prefix, contain no
more than 1,000,000 bytes, equal that request's exact ordered original B prefix,
and contain no C overflow. Both servers independently repeat this complete
input/layout twice, with a successful recovery upload after every failure. For
this explicitly failed, unacknowledged stream role, comparison uses the public
status/type/body, independently checked prefix invariants and exact recovery
response/file. Every complete file's original length, SHA256 and bytes remain
diagnostic observations, including same-process Native repeatability. They are
not required to equal an independent HTTP call's incidental retained length.

This follows the designated `ClientEventLogger.cs:34–38`, which creates the real
FileStream, awaits `fileContents.CopyToAsync(fileStream)` and disposes that owner.
The public error and copy operation do not specify the partition of transport
reads before failure. Run `40508298575` retained Native/Node lengths of
815097/992249 on Linux, 274425/983033 on Windows, and 409593/983033 on macOS;
all complete files were valid B prefixes with the same public 500 response.
Those original failures remain recorded. Run `40512183895` required a complete
999424-byte fstat handshake, but the real live Native file exposed only 995328
bytes until the 30-second request timeout closed and flushed its last 4096
buffered bytes. Its live-request guard correctly rejected that closed-request
witness. No production buffer behavior is changed to reproduce either layout.

A separate real chunked success control sends all 999,000 B bytes with the same
65,536-byte first write, positive live witness and second-write layout. Both the
encoded chunk body and the actual fresh socket's total written bytes, including
HTTP headers and framing, must stay below 1,000,000. Native and Node must return
200, pair their response's own newly created FileName, and retain every original
byte with the exact complete size and SHA256. All successful and acknowledged
body lengths remain exact, including the existing declared 1,000,000-byte case.
The original 19-case matrix, declared oversize rejections, active disconnect,
FileHandle/EBADF shutdown checks, ports and request/test budgets are retained.
The Node production close additionally blocks an observed real
FileHandle's close while checking that runtime close has not completed; releasing
the actual close must yield EBADF, closed listeners and an available port.
`real-files.js` only wraps native `fs.open`/`FileHandle.close` for this observation;
it supplies no file data, paths or fake successful resources. Native handles are
released by its normal clean shutdown and confirmed process exit. No whole
library, complete-instance, production-scale, phase or release acceptance is
claimed by this endpoint test.
