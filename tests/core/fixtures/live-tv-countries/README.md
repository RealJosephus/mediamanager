# Countries and persisted image-limit evidence

The oracle constructs the actual designated `SchedulesDirect` class and invokes
its actual GetAvailableCountries, constructor LoadDailyLimitDate,
IsImageDailyLimitActive and private TryDeleteFile. No SD account, listings token,
recording, guide download or executor is started. Source bindings cover the
provider, controller, named-client constants and Startup default HTTP setup;
the raw report records assembly/input hashes and the actual UTC calendar day.

The declared IHttpClientFactory boundary preserves the requested Default name,
GET method and original `/20141201/available/countries` URI, then rewrites only
the authority/path to the isolated loopback fixture. Actual HttpClient requests,
responses and physical files execute. The actual default HttpClient deadline is
checked as 100000 ms. Each factory-owned client is disposed after its scenario.
The synchronous DLL recorder runs on an owned Worker so the test thread serves
native HTTP requests; one passing receipt and clean worker exit are required.

Eight physical cache scenarios compare raw base64 bytes, disk state, request
count and error class: fresh malformed and zero-length files, stale-at-seven-days,
future mtimes, permanent in-memory bytes after overwrite/delete, cold reopen,
HTTP failure retry, parent-file blocker and destination-directory blocker.
Nothing parses or normalizes country JSON. The native returned stream is
non-writable; Node returns independent Buffer copies so callers cannot mutate
the private in-memory bytes. Native TryDeleteFile is additionally invoked on an
actual directory to prove UnauthorizedAccessException is not swallowed.

Eight actual daily-limit initializations use absent/today/future/past/invalid,
InvariantCulture month text, UTF-16 BOM and explicit-offset files. They use the
actual native UTC day, not an injected native clock. Overwriting a file after
construction proves the retained date is loaded only once. The Node counterpart
uses those actual raw file bytes and the same real UTC day. Additional Node
clock controls prove expiry after a day boundary and the clear-before-delete
prefix, including a denied cleanup followed by an inactive second read.

Separate Node tests use actual loopback HTTP and actual cache files for readonly
byte ownership, independent simultaneous cold requests, closing during an open
HTTP body, the independent timeout, and create/truncate followed by write failure.
The last failure leaves a fresh empty cache which a later call reads as empty;
it does not invent a retry that native freshness would suppress. Explicit
filesystem-error controls cover IOException read/delete fallback and permission
errors. Those controls are not claimed as native physical read failures: native
static File I/O is not replaced or intercepted. Every opened Node file handle,
HTTP response, worker, client and server belongs to a test lifecycle owner.

The client owns only SD countries discovery and the migrated image-limit marker.
It does not claim a complete Schedules Direct listings implementation. Production
uses the default 100-second independent client deadline; the short timeout test
injects a smaller duration to exercise cleanup without waiting 100 seconds. Close
rejects new operations and drains admitted operations, and does not use an HTTP
request's AbortSignal to cancel the controller's CancellationToken.None path.

Only Actions may execute these tests. The fixture is component evidence and does
not constitute phase or final release acceptance.
