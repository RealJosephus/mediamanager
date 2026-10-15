# Artist refresh state observations

These eight recordings extend the designated Artists task with a controlled
provider that observes the actual entity it receives. The original C# source,
project, input and recording are preserved byte for byte and bound by provenance.
The actual repository, LibraryManager, batch lookup, SQLite persistence and
UnsafeFast deletion remain in use. No media or server port is opened.

Batch lookup returns scalar Artist objects with unloaded provider, lock, image
and linked-child state. The deterministic-ID fallback loads those relations.
Controlled calls to the actual SaveItems verify that saving these different
objects clears or retains their relations accordingly. Name/date mutations and
ordinary failures reveal shared object state between initial batch matches;
fallback lookups continue to follow the repository/cache lifecycle instead.
Later repository updates do not change the frozen batch objects.

The metadata provider is controlled, including the two SaveItems cases. This is
not an observation of the complete native MetadataService or client lifecycle.
