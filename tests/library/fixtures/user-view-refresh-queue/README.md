# UserView refresh queue oracle

`native.json` preserves the full raw output from the frozen Jellyfin DLLs, executed by `Program.cs` on .NET 10.0.12. `provenance.json` binds raw oracle/project bytes, eleven frozen source files and each actually loaded assembly. The project references the ignored frozen baseline only when explicitly rebuilding the oracle; runtime tests read the portable recorded output.

The five queue controls exercise repeated ids, serial metadata-service execution, ordinary errors, independent provider cancellation, synchronous disposal cancellation and Normal-priority tie order. Nine distinct items produce service order `1,2,9,8,7,6,5,4,3`; equal priorities are not FIFO. Disposal returns before the controlled active service finishes and leaves the next queued entry unexecuted. The candidate's host close separately waits for active resource use to finish before releasing resources.

The remaining six native controls exercise real UserViewMetadataService with controlled provider/persistence dependencies. The queue test compares only service starts/successes/finishes, errors, peak concurrency and disposal milestones. It does not turn repository dependency calls into SQL evidence, does not prove all priorities, real HTTP cancellation/races, cross-process writes or complete native host shutdown. `phaseAcceptance=false`.

Original evidence: `.test-input/evidence/user-view-refresh-queue-implementation-v1/`, derived by copying the retained lifecycle v3 oracle to a fresh directory and adding a distinct-id Normal-priority control. The lifecycle v1/v2/v3 raw outputs remain unchanged.
