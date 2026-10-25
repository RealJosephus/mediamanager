# Current public JSON and item Data strings

`current-profile.json` binds the neutral UTF-16 inputs to the current designated
Native Oracle under `current/`. All six samples run under the three actual
JsonDefaults profiles. The current Node producer writes its public bodies and
item Data into `node.json`; the Native reader consumes those exact strings and
records their input digest alongside the independent Native-produced output.
Public JSON compares lossless values and Native readback, preserving Int64,
nulls, arrays, dictionary keys, and surrogate replacement.

The item branch uses the current `BaseItemMapper.Map` and
`DeserializeBaseItem`. Its `Video` instances have an explicit empty recording
context: the mapper can query active recording information and receives no
active recording. Other recording operations reject calls outside this JSON
probe. It compares the persisted `Container` string token byte
for byte and reads both Node and Native Data through the opposing typed reader.
The raw complete Data is retained, but only that string field is in this gate's
persistence scope; this is not PostgreSQL/SQLite transfer or full item acceptance.
All Node inputs, Native results, and source/build/run receipts remain in the
validation output. The original sources, `README.md`, `native.json`, and
`provenance.json` remain unchanged incomplete historical archive material and no
longer gate current execution.
