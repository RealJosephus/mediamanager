# Live TV configuration model and storage

`Program.cs` executes the designated DLL's actual XML model serializer and
ConfigurationHelper. The input cases cover full LiveTvOptions, TunerHostInfo,
ListingsProviderInfo and NameValuePair fields, constructor defaults, accepted
XML and recovery. A second actual native process consumes Node-produced XML.
Reports retain raw native output, input/output hashes and assembly provenance.

Node's model is `src/core/resources/live-tv-configuration-model.json`; its reader,
serializer and named file/cache owner are exported directly by
`src/core/live-tv-configuration-store.js`. `LiveTvService` inherits that owner and
adds user/guide business methods. The named cache test uses this actual subclass;
`live-tv-configuration-store.test.js` separately constructs the core owner to
cover read/write failure prefixes, object identity, case-sensitive cache keys,
serialized cold reads, admitted work and close. Observer/dependency shutdown
is covered by `live-tv-configuration-close.test.js`. These Node lifecycle tests
do not claim an actual native HTTP or native shutdown differential.

All native and Node files belong to isolated private fixture/output roots;
original reference inputs are unchanged. ConfigurationHelper recovery is
distinct from the named manager's missing/malformed-file read behavior. No
stream, recording or encoder execution starts, and these component observations
do not establish final Live TV or release acceptance.
