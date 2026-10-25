# Frozen Series getter and user data key contract

`Oracle.cs` is the exact executed source. `native.json` preserves all twelve
actual Episode/Season getters and GetUserDataKeys results, explicit parent and
provider inputs, field readback, contradictory saved ancestors, and the actual
System.Text.Json ignored Series/SeriesId alias control. It also retains seven
actual EF SQL translations from the frozen repository ApplyOrder method.

Reproject with `node tests/sessions/fixtures/series-reference/project-native.mjs
<evidence-directory>`. The fixture pins the four raw process leaves, ten native
source files, seven copied loaded DLLs, native SQLite library, all loaded managed
assemblies and the executed source by SHA-256. Portable tests read only the
tracked fixture and source; they never require the ignored native build.

Entity lookup, default configuration, empty recordings and unused locking
interfaces are controlled. The actual entity methods and SQL translation run
unchanged. No native database query, HTTP request, host lifecycle or port is
opened. Candidate tests separately execute real SQLite and PostgreSQL reads,
including persisted wrong ancestors and serialized getter aliases.

A nonempty SeriesId only resolves that ID as a Series; a missing or wrong type
result stays null. Only an empty ID searches the real ParentId chain. Already
evaluated domain references are typed values, including a resolved null; SQL
hydration cannot turn JSON's ignored Series alias into that runtime reference.
