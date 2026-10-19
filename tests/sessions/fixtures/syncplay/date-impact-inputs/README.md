# Native SyncPlay date-impact inputs

`binding.json` binds two actual recordings of the designated Jellyfin workspace
to the shared native identity reference, preparation files, runtime and SDK.
The logical input root is `.agent-docs/evidence/syncplay-date-impact-inputs`;
`MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT` supplies its physical location.
The consumer requires both recordings and rejects missing or changed inputs.

The six requests cover minimum-year offsets in playing and paused states plus
the inside and outside branches of the two-second Ready guard. The measured
HTTP/WebSocket contract is byte-identical to the retained original native
contract. Fresh provenance, raw responses and summary hashes belong to the
new recordings; historical binary and raw-response hashes are not aliases for
the restored reference build.

Preparation uses the exact eleven-input allowlist from the native identity
binding. The helper verifies full recording-directory digests, artifact sizes
and hashes, source bindings, both readiness/shutdown observations and the
independent restoration audit. Output paths cannot overlap native inputs,
the source database, runtime or SDK.

Database evidence covers the 31 tables in the business model. In each native
recording, their digests are unchanged from authentication through the six
cases. Shutdown adds exactly two ActivityLogs rows and preserves every other
observed table. Candidate PostgreSQL evidence records the complete model digest
after authentication, after each target Ready request and after the scenario,
and retains raw HTTP/WebSocket responses before comparison. Request When values
must not persist. After this persistence window, candidate cleanup completes
the server WebSocket close handshake before the sealed recorder terminates its
clients. The capture also retains the model digest after that handshake and
requires no reported errors through runtime shutdown. The strict-run resource audit separately checks owned schema
cleanup and preservation of existing schemas.

This is focused behavior evidence. It does not seal native PID identity,
actual FFmpeg execution or complete build inputs, and it does not cover every
physical SQLite table, general date conversion, full clients or final release
acceptance. These limitations remain explicit false flags in the binding.
