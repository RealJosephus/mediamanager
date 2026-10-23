# Current reader execution

[`current-profile.json`](current-profile.json) selects the current component
consumer test, [`consumer-readers.test.js`](../../consumer-readers.test.js).
It runs the designated Native build in the same Actions job and sends current
Node output through the actual Native readers and writers. The reverse direction
uses that execution's output. See [`current/README.md`](current/README.md) for the
coverage and receipt layout.

The root `input.json`, `native.json`, `binding.json`, `provenance.json`,
`Program.cs`, and `Oracle.csproj` retain their original bytes and recording scope.
The historical loader's external recording paths are not dependencies of this
current consumer. The current neutral input is an exact copy of the original
input; it contains no expected Native observations.

Neither a component recording nor a successful component comparison grants
phase or release acceptance. Those decisions require the complete Actions scope
and its independent audits.
