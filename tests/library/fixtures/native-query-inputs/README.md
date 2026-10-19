# Controlled native query inputs

This binding names the newly recorded native query inputs, not a restoration of
the unavailable historical recording paths. The runtime was rebuilt from the
designated dirty Jellyfin workspace using a byte-verified SDK/package snapshot;
the source database was initialized from empty through actual native APIs.

`binding.json` pins the source database, eleven exact preparation inputs, the
controlled runtime and SDK directories, and both independent native repeat
audits. The original preparation, artifact, state, current-file and executable
checks remain active in the test helpers. Every native case and expected HTTP
response remains unchanged.

Set `MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT` to
`D:/mediamanager-validation/20261011/filter-results/item-filter-restoration-v1`
and `MEDIAMANAGER_USER_VIEW_INPUT_ROOT` to
`D:/mediamanager-validation/20261011/view-results/user-view-restoration-v1`.
These namespaces do not alter the existing historical/native-instance inputs.
Validation output must be separate from both input roots.

The nine filter scenarios contain 164 cases and 356 complete HTTP records per
native repetition. The three UserView scenarios contain 712 complete HTTP
records per repetition. The filter audit allows only explicitly validated
top-level problem trace identifiers to differ; UserView repetitions require
exact complete response equality. Candidate comparisons retain the original
declared server/account identity normalization and all persistence assertions.
The nine tracked filter tests now also compare the entire HTTP response,
including every DTO field and array order. Their neutral input rows are seeded
from the read-only, hash-bound native source database and the original fixture
declarations, not from expected HTTP responses.

`static-source-permissions.json` binds eight independent video/audio/remux user
permission inputs, two actual native repetitions and their independent audit.
The permission test verifies the full native detail bodies, actual policy
readbacks, the captured candidate media/relations and UserData, filesystem
domains, and normal isolated-instance cleanup. Both native repetitions retain
the original recorder's complete database gates and artifact checks; only the
audited case declaration, expected response count, policy inputs and readback
observation are substituted into its source recipe. This proves static video
source permission metadata, not audio-source negotiation or encoder support.

`static-audio-source-permissions.json` independently binds the corresponding
eight Audio-source inputs, two actual native recordings, and their repeat audit.
The neutral rating fixture changes only the alpha item's CLR type and media
type to Audio; no expected HTTP output is used to assemble candidate input.
The exact recorder recipe retains all original preparation, executable, full
database read/stop, artifact and response guards. Audio SupportsTranscoding
follows only the audio permission bit; video/remux bits are irrelevant and
DirectStream/DirectPlay remain true for this static file source. The formal
PostgreSQL test compares all response fields and state/cleanup boundaries, and
five negative controls reject altered cases, neutral input/hash, directory seal
or oracle hash. This completes the static source permission branch coverage,
not device negotiation, encoder support or arbitrary source protocols.

The identity launch negative-control unit test constructs a synthetic
before/after envelope from verified UserView executable inputs. It does not
claim that an identity recorder emitted that envelope or that historical artist
concurrency evidence has been restored.

These inputs do not prove full media scanning, a sealed native PID identity,
complete build/tool/OS influence closure, all-table UserView per-read gates, or
release acceptance. The native audits document those limits explicitly.
