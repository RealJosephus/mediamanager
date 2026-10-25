# Current Photo and image-lifecycle consumers

Execution identity: `same-workflow-current-native-photo`. These consumers build
and execute the supplied Native assemblies during the current GitHub Actions
invocation. Every selected Native program executes twice in distinct output
directories. The old fixture JSON, recordings, projects and seals are unchanged.

| Native consumer | Original functional inputs |
| --- | ---: |
| PhotoProvider.FetchAsync | 64 photo metadata cases |
| PhotoProvider.HasChanged | 14 timestamp/existence cases |
| Unicode EXIF UserComment | 1 exact same-size header patch |
| Original Primary path handling | 3 local/remote path cases |
| Photo DTO serialization | 19 field/ancestry cases |
| Photo primary aspect ratio | 200 dimension/orientation cases |
| Custom image lifecycle | 18 actual metadata-host/SQLite save-prefix cases |
| Dynamic image host | 30 selection/save/cancellation/file/stream cases |

The five Node test files retain their original functional matrix and expect
397 TAP tests, including nested cases. The runtime integration file independently
captures the current provider over the exact rich-photo bytes and the declared
Primary-path controls. Its own timestamps, storage mounts, SQL and HTTP scenario
remain integration inputs rather than a claimed identical Native host run.
Across all five files this entails 16 Native program executions, 804 result rows and 56
HasChanged observations per platform. Those counts describe the declared test
matrix; they are not object-layout or reference-count requirements.

The current input manifest binds 90 source/input files, including all 56 original
photo assets and the existing Unicode patch declaration/output, DTO inputs,
custom-lifecycle inputs, dynamic-host inputs, actual PNG input and build-reference
contract. No different image or freshly generated recording is substituted for
an original recording. All images remain the original bytes. Each Native output
binds its actual input hash and loaded assembly hashes; the custom lifecycle also
binds the actual SQLite library for the current SDK RID. Its DLL import resolver
uses that supplied library on Windows, Linux and macOS.

The capture consumer verifies the complete same-run build receipt, source offer
and runtime before and after use, and binds 21 relevant Native source files.
Each output directory contains both Native records, a capture report and the
candidate observations. Native controlled seams remain explicit in each program's
scope. Photo runtime HTTP/PostgreSQL integration remains Node integration over
these independently exercised provider/DTO/persistence contracts; this fixture
does not claim a complete Native HTTP-server comparison.

Photo field values, decimal/tick precision, orientation, original/cover image
bytes, primary identity, Unicode corruption, partial metadata mutations, fallback
and cancellation behavior remain assertions. The PostgreSQL, authenticated HTTP,
configured/nested original-vs-metadata mounts, image-row read stability and cleanup
assertions remain. Custom lifecycle tests retain every call/save prefix, probe
reload, SQL-trigger failure, stored field/image, timestamp-change boundary and
source-byte assertion. Dynamic tests retain complete selection, save payloads,
files, image metadata, cancellation outcome and actual Native stream disposal.

R23: Node rejection/propagation and ISO-overflow behavior are compared as outcomes
and error codes. CLR exception names and float32 memory bits are diagnostic only;
the exact numeric CommunityRating value remains compared. The production Photo
fallback accepts its existing `unsupported-image-format` code directly. No
compatibility branch for a CLR exception-name marker remains. Stored Native type
strings are persistence/seed data, not JavaScript private-object requirements.

The timezone remains the original `Asia/Taipei` input. Native execution verifies
the actual UTC offset, and the existing workflow configures Windows system time
to Taipei before execution. No Native timezone cache or private runtime state is
overridden by the consumers.

The seven previously missing TagLibSharp source files and unchanged COPYING
were recovered from official commit
[`b5ae84f2e84087bf160bb0471420200dd2b5d809`](https://github.com/mono/taglib-sharp/tree/b5ae84f2e84087bf160bb0471420200dd2b5d809).
All eight original SHA-256 values match (168,592 bytes total).
`taglib-source/origins.json` retains the original declared locations, exact URLs,
sizes and hashes. The [unchanged upstream license](https://raw.githubusercontent.com/mono/taglib-sharp/b5ae84f2e84087bf160bb0471420200dd2b5d809/COPYING)
matches the shipped `src/metadata/resources/photo-tags-license.txt` byte for byte;
the shipped notice and its source attributions remain bound. The original
historical DLL/build receipts remain unavailable at their declared locations and
are not claimed as restored by these new captures.

Local work is limited to static review, original-byte recovery and input
organization. No local candidate test, syntax check, preflight, runner or build
has been executed. Component and release acceptance remain pending the committed
Actions candidate, complete TAP/registration and schema-3 input receipts, and
PostgreSQL cleanup audit. Capture reports keep phase/release acceptance false.
