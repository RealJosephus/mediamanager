# Complete CI instance exchange

`input.json` declares the whole filesystem movie library owned by
`complete-library-instance-native.test.js`. Each physical media file is an
unchanged copy of the frozen transport identified in `tests/fixtures/frozen-av`.
No media generator, encoder, recording source, or user instance is used.

The test starts the designated same-run Native instance, creates the library
through HTTP, and requires the complete-library verifier's real successful scan,
exact paged library inventory, playback source, original bytes, and Range check
for every declared item. Node then scans one addition, edits metadata and user
state, and deletes an original through the production PG/HTTP runtime.

The same Native and Node HTTP owners also browse an explicitly mapped local
directory with files, directories, hidden names, numeric names, case and Unicode
variants. Full responses compare default flags, each filter, combined entries,
Swedish ordering, required and invalid scalar bindings, missing directory,
file-as-directory, the Native bare-UNC-server result, and anonymous authorization
before binding. Original bodies and response headers remain in the report; only
the actual ProblemDetails root trace and accepted scalar-binding wording are
projected. Component HTTP tests additionally cover Windows, UNC and POSIX
identity roots and reject an existing unmapped host directory through the actual
Local adapter and storage facade.

The file-as-directory error follows the actual Native host: Windows returns
500 and Unix returns 404. The designated `EnvironmentController` enumerates a
`DirectoryInfo` through `ManagedFileSystem.GetFileSystemEntries`; its
`ExceptionMiddleware` maps `DirectoryNotFoundException` to 404 and leaves the
Windows `IOException` at 500. The original Windows response in run 40503178623
is 500 `text/plain` with `Error processing request.`. Each host still compares
the complete corresponding Node response against its own Native observation.
Failed complete-library verification also retains its declaration, successful
scan receipt, rejected field names, and exact bounded virtual-folder response
bytes, so unknown Native response members remain available for diagnosis.

A complete state package captures every instance root and current PG table.
Restore compares every state asset, including unknown plugin bytes, with only
the declared system configuration root projection. All native tables, schema,
complete migration history, sequence high-water marks, and six insertion-order
streams are compared at each exchange boundary. The original Node instance is
retained separately before Native starts the restored package.
The package's declared instance-owned paths use the existing AppData/Metadata
token projection. All 31 tables and six order streams compare in that explicit
representation, while independent raw snapshots prove the source PG generation
unchanged. Full package metadata and exact changed-cell diagnostics are retained
before assertions; unknown and invalid UTF8 Data cells keep their original bytes.

The designated `ApplicationHost.cs:286–304` expands and reverses
`%AppDataPath%` using `ApplicationPaths.DataPath`. The designated
`AppBase/BaseApplicationPaths.cs:31–36,49–52` places that directory below
`ProgramDataPath/data`; `ServerApplicationPaths.cs:34–37` instead places the
root folders below `ProgramDataPath/root` and metadata below
`ProgramDataPath/metadata`. In run 40503178623 the former export incorrectly
turned the absolute collection-folder root into `%AppDataPath%/root/...`, and
the restored Native log consequently tried the nonexistent `data/data/root`.
That failure's virtual-folder body was not retained, so the exact rejected
response field cannot be recovered from that run.

Export now retains those absolute root-folder paths and uses Native tokens only
for their actual DataPath and metadata roots. Restore projects declared
instance-owned path columns and each configuration folder's exact owner entry
in `PhysicalLocationsList` into the destination. It works on a private SQLite
copy, rechecks all 31 tables plus schema/history/sequences, and binds the source
and target checksums and explicit roots into the restore layout digest. The
captured package and source PG remain unchanged. The full-instance test compares
all 31 tables and six insertion sequences in the destination representation
before Native restarts. `state-package-instance-paths.test.js` also exercises
default and external metadata, two destinations, interruption/resume, idempotent
restore, original Int64 text, invalid UTF8, and unknown paths that must not move.

Database preparation belongs to the current restore lease and staging tree.
Its directory name binds the manifest, destination, original database checksum,
and explicit source/destination instance roots. A complete atomic `binding.json`
precedes database bytes. A later owner validates the binding and every member
before removing its private database, SQLite journals, or corresponding atomic
temporaries; unbound databases, wrong bindings, extra members, links and unrelated
request directories fail without deletion. The verified database is the first
restored file, and preparation is removed before any file-progress callback.
The recovery process test kills a real owner after its preparation SQLite opens,
then requires the next owner to recover those exact bound files before the
existing first-file interruption. All 31 tables and six order streams compare
in the declared destination representation. Deliberate process interruptions
remain separately labeled from naturally completed owners.

The preparation directory encodes the entire request SHA256 in compact base64url
under its existing generation-bound staging. This preserves the complete binding
while leaving room for SQLite's journal suffix on Windows. The first bound-copy
run passed all 77 tests on Linux/macOS, but Windows could read the long preparation
database and failed when its first update had to create the longer journal path;
the original Windows failures remain recorded.

Native consumes Node's metadata and user changes, verifies the restored complete
library, adds another frozen source, edits metadata, and deletes Node's addition.
A fresh PG import and cold production runtime must retain the complete native
state and pass the same scan/inventory/byte checks. Ports, Native process,
runtime, proxy, and PG owners close through their normal owners before private
fixture cleanup; the surrounding strict CI audit checks global DB resources.
The original PG generation is independently compared after the restored Native
and fresh PG consumer finish, including all tables and relation-order streams.

`completeLibraryVerified` and `fullInstanceVerified` are set only after these
assertions, and apply to this complete CI-owned instance: one library and three
present media files at each completed phase. `productionScaleVerified`,
`phaseAcceptance`, and `releaseAcceptance` remain false. The separate large
catalog exchange measures declared generated row cardinality; it does not
expand this test's physical-media coverage.
