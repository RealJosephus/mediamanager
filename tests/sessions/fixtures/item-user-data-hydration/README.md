# Native stored item hydration and user-data keys

The 132 controls run actual SaveItems/EF SQLite, then replace Data and six nullable SQL lists on the materialized EF entity before invoking BaseItemMapper.DeserializeBaseItem and each concrete GetUserDataKeys. Twenty-seven types cover NULL and valid Data with retained or NULL lists; twelve source-serialized types also receive malformed Data. The original persisted Data is checked separately. Parent and collection lookup, options, recording state and path expansion are controlled.

The candidate compares exact keys, six hydrated lists, JSON type policy and RemoteTrailers through the actual session hydrateItem entry point. SQLite and real PostgreSQL replay nullable stored rows, invoke UserDataService favorite mutation, compare persisted key rows and the event key sequence, and verify BaseItems remains unchanged. Provider and Series lookup are empty controls. Candidate mutation behavior does not add native HTTP or reattachment evidence to this recorder.

SQL NULL lists hydrate to empty arrays; this differs from explicit NULL lists supplied to a live entity before saving. The original recorder remains candidateVerified=false. These controls do not establish full JSON/scalar mapping, reattachment SQL, complete-library scanning or release acceptance.
