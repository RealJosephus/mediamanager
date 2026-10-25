# Current local XML consumers

The current consumer is [`local-xml-provider.test.js`](../../local-xml-provider.test.js).
[`current-profile.json`](current-profile.json) binds the neutral inputs, current
oracle source and project, and the designated Native source offer. See
[`current/README.md`](current/README.md) for coverage and evidence boundaries.

The root input, Native output, oracle, project, README and provenance retain
their original bytes. The historical `reader-layouts` inputs and records are
also unchanged. Current execution copies the neutral inputs into `current/`
and runs the designated Native build in the same Actions job; the old external
recording paths and old runtime hashes are not current execution dependencies.
