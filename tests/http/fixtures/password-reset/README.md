# Password reset oracle

`input.json` runs 83 HTTP scenarios (84 requests) through the designated
UserController, SessionController, MVC binding, authorization and exception
middleware. Five additional scenarios call the actual UserManager.UpdateUserAsync
directly; their outcome codes are helper categories, not HTTP observations.
The actual UserManager, default reset/authentication providers, cryptography,
EF SQLite and physical files execute in an isolated instance per scenario.
Network classification, the authenticated principal and event consumers are
controlled. This does not establish full native-instance or Web-client acceptance.

Observations preserve the complete five-table user state, response, file inventory,
method calls, password events and independent password verification. They include
binding and malformed-file cases, Unicode names, provider fallback, partial
redemption, write/event/delete failures, stale user snapshots, relation updates
and transaction rollback. Snapshot save always rebuilds access schedules. An
uninstalled authentication provider performs the actual InvalidAuthProvider no-op.

`native.json` contains original recording bytes. `provenance.json` binds neutral
input, designated and isolated source hashes, helper sources, loaded managed and
SQLite native libraries, build/run and independent repeat. It does not reconstruct
the complete historical build-input closure. Generation-time identities and
random PINs are validated and bound consistently before comparison; password
hashes are checked structurally and cryptographically before masking randomness.
HTTP trace IDs are diagnostic. Allow compares the case-sensitive method set
defined by RFC 9110 section 10.2.1; raw header order is preserved. File inventory
order is diagnostic, while calls, events and UsersReset order remain contractual.

The `read-files` mode deserializes original Node-produced bytes using the actual
private SerializablePasswordReset type and default System.Text.Json reader.
`consumer.json` binds those producer observations, byte manifests, typed readings,
assemblies and helper execution. JSON layout and escaping are compared through
that reader; invalid JSON/string/date failures retain their native behavior.

```text
node tools/compat/record-password-reset.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY
node tools/compat/check-password-reset-files.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY CANDIDATE_EVIDENCE_DIRECTORY
```

Candidate tests use actual PostgreSQL and files. Separate runtime tests verify
anonymous requests, persisted PINs across restart, password login, token retention,
unrelated state, state-directory ownership and draining closure. Complete native
event consumers, external providers, supported platforms and both Web clients
remain separate acceptance work.
