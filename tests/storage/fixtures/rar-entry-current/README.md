# Current RAR entry and directory consumers

`input.json` independently declares the 30 directory scenarios and 13 selected,
password, cancellation and compressed-stream scenarios originally exercised by
`book-comic/rar-directory` and `book-comic/rar4-entry`. The old inputs, observations
and provenance remain unchanged. Missing old helper assemblies and synthetic
archive generators are not replaced under their former identities.

The original upstream RAR4, RAR5 and encrypted RAR4 assets are shared read-only
with `book-comic-current`. `assets/Rar.solid.rar` was recovered from the same
pinned SharpCompress repository revision at its original SHA-256; its source and
license are recorded in `asset-source.json`. Synthetic archives use new literal
names, payloads, Unicode commands and mutations in the declaration. They are new
inputs, rather than reconstructions from recorded expected output. `Program.cs`
writes genuine stored RAR4/RAR5 headers, checksums and data from those declarations.

`capture.js` verifies the supplied designated Jellyfin build and bound source
offer, then independently builds and executes the oracle twice in new output
directories. The actual loaded Controller, Providers and SharpCompress assemblies
must match that build. The actual `ComicImageProvider` and SharpCompress readers
produce every result; selected entry streams are opened on fresh archive readers
so preceding reads cannot supply solid history. Each output, source archive,
selected file, complete catalog and returned prefix is retained and hashed.

The directory cases cover separator collisions in both orders, dash sorting,
backslash collisions, directory selection, trailing slashes, dot paths, duplicate
first lookup, all four RAR4 Unicode commands, correction, UTF-8 fallback and
truncation, plus both complete upstream catalogs. Every key, ordinal, size,
directory flag, successful selected byte and cover outcome is compared to the
same-run native observation. Native host path conversion is exercised directly;
the tests do not choose expected keys by operating system.

The additional cases retain normal/bad-CRC/solid reads, default-null versus
explicit-empty password, explicit-wrong password, selected salt mutation,
pre-cancellation, cancellation after one millisecond and removal of the selected
salt. The explicit password controls measure the native archive API; the public
Book archive consumer has no password option. Both cancellation operations use
their real cancellation signals and record whether cancellation was requested.
The designated async reader does not apply the synchronous CRC stream wrapper:
an explicit wrong password can return unusable bytes rather than throw. Its
complete returned bytes and failure boundary remain in both native captures;
the password control requires a different payload from the empty-password read.

The three compressed-stream cases execute the actual native compressed-stream
producer and compare its exact returned bytes, lengths, hashes and 32-byte
prefixes to the payload prepared by `prepareRar4Entry`. The CLR stream class name,
exception class/message and private salt wrapper are raw diagnostics. Functional
comparison uses returned bytes and failure boundaries. Failed native entry reads
also preserve the actual returned prefix in their raw output. The Node Book
archive API returns a complete buffer or rejects atomically; rejected reads expose
no partial buffer. Failed covers expose no image on either implementation.

The Node tests use actual workers and media VFS. They verify first duplicate
lookup, unchanged original bytes, caller source-position preservation, create-only
spool behavior, closed source descriptors, rejected reads after reader close,
balanced original-media streams, and empty original/derived spools after normal
operation and owner close. This is component evidence, not a full-instance or
release acceptance claim. Candidate tests and builds run only in GitHub Actions.
