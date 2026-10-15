# Frozen refresh progress contract

`native.json` preserves the complete output of the real frozen DLL membership,
CollectionFolder progress getter, and LibraryChangedNotifier progress method.
`Oracle.cs` is the exact executed source. Reproject with
`node tests/library/fixtures/refresh-progress/project-native.mjs <evidence-directory>`.
The fixture pins all input fields, native output, source files, project, process
exit and six loaded DLLs by SHA-256.

The controlled dependencies provide explicit user-root children, entity lookup,
active provider progress, configuration and session capture. Membership, cached
physical-folder lookup, progress averaging, and notification payloads run the
actual methods. A fresh notifier is used for each phase so throttle timing is
outside this oracle. Native SQL, live provider events, native WebSocket envelopes
and full host lifecycle were not invoked. Candidate HTTP/WebSocket lifecycle is
covered separately by the two real runtime tests.

The contract distinguishes exact OrdinalIgnoreCase membership (including POSIX
case), separator/trailing-separator mismatches, a matching nested folder outside
the user root, path-only membership without cache completion, and cached
aggregation of 0/40/40/20/0/null across six phases. The path-only progress getter
stays null even when that collection's own provider progress is 66; the notifier
formats it as 0. A collection under the user root is not itself a top-parent
refresh producer. JSON's ignored PhysicalLocations alias remains empty.
