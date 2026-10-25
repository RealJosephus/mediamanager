# Native resolved-item updates

The 86 fixed inputs invoke the actual pinned BaseItem/Video.UpdateFromResolvedItem methods through reflection. They cover ten entity types, mixed-folder changes, ordered/case-sensitive part and alternate arrays, null arrays and null elements, video types, type mismatches and repeat invocation. Int64 values are compared with lossless JSON.

The projection preserves metadata and identity spelling and records native update flags, sequence reference assignment, exceptions and second-call results. Empty arrays are interned by native JSON deserialization; the candidate control uses the same empty-array identity. The native array overload compares spans, so null and empty arrays compare equally without replacing the original property.

The candidate's pure update tests and separate SQLite/PostgreSQL scan tests are distinct evidence. This fixture does not execute native ValidateChildren, repository writes, image updates, media enumeration, ownership transfer, alternate-version refresh or a complete library. The oracle's candidateVerified remains false; strict candidate results are recorded independently.

Sources come from the isolated capture of the designated D:/jellyfin workspace, including local modifications. Provenance binds the input, native output, oracle source/project, actual assemblies and source content hashes. No candidate expected output is used to construct the oracle.
