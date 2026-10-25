# Current Episode block and failure-prefix comparison

All 56 base inputs and 168 layout variants are retained unchanged. The current
oracle writes their exact UTF-8 bytes to physical NFO files and calls the
designated `EpisodeNfoParser`. Node then reads the same files through both
`parseNfoAsync` and, for the existing subset without injected callback failures,
`parseNfo`.
The copied layout relation list also retains all nine scalar-prefix
counterexamples and the equivalent layouts, using current Native values.

The comparison retains block order and merge behavior, item and provider values,
people and images, metadata assignment before failure, existing-item saves,
cancellation, and failures at user lookup, data lookup or save. The comparison
uses the ordered save attempts, each successful committed save, final shared
and committed user-data values, and failure presence. Sync comparisons retain
the full metadata projection for every previously eligible input. Full lookup,
save and cancellation traces are recorded for diagnosis. Lookup counts and
ordering, callback attempt counters, runtime error classes and cancellation
token properties do not determine functional success.

The user and user-data managers are controlled callback consumers, so their
committed-value snapshots do not claim actual database transactions or events.
This fixture also does not claim provider discovery, local-image I/O, complete
metadata refresh or instance exchange.

`xml-reader-current-fixture.js` binds current input/source/project hashes to the
full same-job Native build and runtime closure. Evidence under
`nfo-episode-blocks-current-*` retains the generated neutral scenario document,
Native build/process receipt and raw output, physical NFO files, loaded assembly
hashes, source bindings, and full Node sync/async observations. Component success
never grants phase or release acceptance.
