# Current local XML parser, provider and merge comparison

The current input keeps all 46 base parser cases and all 135 layout variants.
The designated Native `BoxSetXmlParser` and `PlaylistXmlParser` each consume
every case, yielding 362 parser observations. The ten actual file-provider
cases, six BoxSet merges and five three-stage merge pipelines remain intact.
The copied layout relation list retains all 24 failure-prefix counterexamples
alongside the equivalent layouts, comparing functional values from the current
Native execution against its current base cases.

`Program.cs` writes each present neutral input to a physical file and calls the
actual Native reader. The observation includes the filename, bytes, SHA-256,
metadata values and any error. Node reads those same files, decodes them through
the production reader and records complete results before comparing them.
Missing files remain missing; parser failure prefixes, people, links, owners,
shares, identifiers, dates and numeric values remain visible. Provider tests
read the actual Native XML bytes through the production virtual-file interface
and retain file discovery, cancellation and strict saved-time comparisons.

Node link and merge operations use the actual PostgreSQL relation store.
Parser/provider observations and all three pipeline boundaries retain the
ordered link values, including duplicates. The tests still release entities,
check the store and spool for leftovers, and close and drop the owned database.
The separate state-local file test retains real reads and symlink confinement.

The functional comparison uses failure presence and metadata/link values.
Exception classes, messages, provider names and provider ordering remain in
the raw observations. No Windows version, original runtime hash, provider
registration order or internal JavaScript property set determines functional
success.

`xml-reader-current-fixture.js` verifies the profile, full designated Native
build identity and loaded runtime assemblies, then retains the build/process
receipt, complete Native result, actual input files, source bindings and Node
observations under `local-xml-provider-current-*`. Neither phase nor release
acceptance is granted by this component capture. Native repository persistence,
full refresh, HTTP and instance exchange remain separate validation scopes.
