# Current ordinary global scan and ignore boundaries

This is a new current identity: `same-workflow-current-native-global-scan-runtime`.
Both runtime consumers execute this producer against the designated Native build
in the same Actions run. It does not reinterpret historical output. The original
`global-scan-runtime` helper and input and `scan-ignore-runtime/native.json` remain
unchanged; the original input bytes are an explicit input of this producer.

The actual LibraryManager runs all eighteen ordinary-directory scenarios. The
host still uses real Native discovery, folder scheduling, metadata services and
SQLite writes. It records complete 72-column BaseItems rows, relationship tables,
fault occurrences, monitor and post-task prefixes, paths, clocks, progress and
released resources. The two original cold-reader scenarios still execute the
actual BaseItemRepository reader on their own new SQLite row, including the
original container, added Folder IsRoot property and malformed readonly container.
The post-task bodies, directory monitor and absent external metadata providers
are explicit component controls; this is not complete product scan acceptance.

`Cancelled` is produced in the actual Native catch by testing the caught error
with `error is OperationCanceledException`. Consumers compare success,
cancellation and failure. CLR exception names, messages and stacks remain raw
diagnostics. They do not determine the candidate outcome. The candidate still
uses its public cancellation result and retains every SQL, persistent-field,
event, progress, fault, file, commit-prefix, cache and cleanup assertion.

`current-profile.json` binds the exact helper, capture and neutral input bytes.
The capture verifies the same-run full Native source offer/build receipt, the
specific scan and persistence sources, the actual loaded runtime assemblies and
its own Oracle assembly before admitting output. It retains original build/run
records, per-case raw observations, independent reader output, release evidence
and a capture report. PostgreSQL candidate observations and cleanup remain under
the Actions registration, input, candidate and service audit gates. This fixture
does not change the historical identity or claim phase or release acceptance.
