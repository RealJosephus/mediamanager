# Current API key consumers

All 59 original neutral HTTP scenarios run through the workflow's designated
Native MVC controller, authentication manager and EF SQLite repository. A second
independent process repeats them. The Node HTTP application uses its actual
PostgreSQL repository, including insertion and deletion failures.

Assertions compare status, content type, allowed methods, complete public JSON
or plain response body, and every persisted API key row after each request.
Generated tokens remain distinct, retain their public format and bind to their
creation request and later DTOs; only their unknown values and proved timestamps
are projected. Internal manager call traces remain diagnostic.

The profile binds current source, runtime, platform SQLite and output bytes.
Historical inputs, captures, provenance and observation code are unchanged.
The independent API key exchange test retains actual Native continuation of a
Node-exported SQLite database and subsequent PostgreSQL reimport. Component
success does not establish complete-instance or release acceptance.
