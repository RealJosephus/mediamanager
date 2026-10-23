# Password reset oracle

`current-profile.json` defines the current Node-to-Native PIN-file gate. The
current Node `DefaultPasswordResetProvider` writes three same-run files in
separate owned directories for ASCII, entered-name case, and Unicode cases.
The designated Native public `RedeemPasswordResetPin` consumes those exact
bytes, returns the expected user, requests one password change, and deletes the
file. The focused Oracle uses strict path, application-host, and user-manager
controls; it does not reflect the private serialized type or compare CLR,
assembly, runtime, build-path, or JSON-spelling details.

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

The historical `read-files` mode deserialized original Node-produced bytes by
reflecting the private SerializablePasswordReset type. `consumer.json` binds
those old producer observations, byte manifests, typed readings, assemblies,
and helper execution. It remains unchanged as incomplete archive evidence and
does not enter the current release input identity.

```text
node tools/compat/record-password-reset.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY
node tools/compat/check-password-reset-files.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY CANDIDATE_EVIDENCE_DIRECTORY
```

Candidate tests use actual PostgreSQL and files. Separate runtime tests verify
anonymous requests, persisted PINs across restart, password login, token retention,
unrelated state, state-directory ownership and draining closure. Complete native
event consumers, external providers, supported platforms and both Web clients
remain separate acceptance work. The current focused reader gate uses a controlled
Native user manager; it proves Node-to-Native persistent-file continuation, not
Native EF/SQLite password persistence, the reverse direction, R7/R9 exchange,
state-package carriage, full, strict pair, phase, or release acceptance.
