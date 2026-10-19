# Native API-key management

`Program.cs` executes the designated `ApiKeyController`, ASP.NET MVC binding, the elevated role policy, `AuthenticationManager`, EF SQLite and real database constraints. Authentication principals and middleware configuration are controlled. The manager proxy records invocations and forwards each one to the actual manager; it does not implement persistence.

The fixture has 59 scenarios and 65 HTTP requests, including elevated authorization, required app/token binding, CLR whitespace, BOM/NUL, preserved names and duplicates, method dispatch, encoded route values, DTO defaults and ordering, exact token deletion, creation/deletion failures and a multi-request lifecycle. The two recordings in `provenance.json` use the same input and oracle bytes and have equal functional observations.

`observations.js` validates generated version-four UUIDs and creation times against their actual request windows before projecting them. Persisted values, token case, response DTOs, errors, calls and operation order remain comparable. Public JSON is compared by value, trace IDs are omitted, and Allow is compared as a case-sensitive method set. The raw recordings stay unchanged.

`api-keys.test.js` replays all scenarios through actual PostgreSQL and the candidate HTTP application. The runtime suite separately covers real token authentication, restart, exact self-revocation, absence of session side effects, operation admission/close, a 20,000-key snapshot under concurrent writes and late construction rollback.

The consumer executes the actual controller and manager against the candidate's exported native SQLite, reads existing keys, attempts an uppercase deletion, deletes a real token and creates a new key. The exchange test reimports its actual writes and compares every table digest and candidate cold reads. This is a database/controller continuation proof, not a full native instance, client or supported-platform acceptance.
