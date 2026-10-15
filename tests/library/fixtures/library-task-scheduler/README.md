# Shared library task scheduling

The three untouched recordings run the real `LimitedConcurrencyLibraryScheduler`
with `DOTNET_PROCESSOR_COUNT=4`, `3`, and an independent repeat at `4`.
`Program.cs`, the project, records and reference-source bindings are preserved
with SHA-256 descriptors in `provenance.json`. Gates control worker entry and
completion. An inline `SynchronizationContext.Post` controls per-slot progress
delivery; the native queue and workers still execute normally.

The 16 cases record independent sequential calls versus pooled work, overlapping
worksets, nested calls on the same or another scheduler, half-even progress,
worker errors, active/queued cancellation, empty inputs, disposal, application
stop, live configuration and independent instance lifetimes. No SQL, metadata
providers, directory watcher, library scan or client workflow runs here.

Candidate comparisons protect invoked members, results and error/cancellation
boundaries, nested completion, progress averaging and isolated ownership.
Pooled workers share the current fanout budget with at most 128 active callbacks
and pages of at most 128 entities, matching the Node bounded-cohort resource policy.
Explicit concurrency one and
default processor counts below four keep the native independent sequential
branch. Nested calls from an active pooled callback run inline and retain the
parent SQL context. Other pooled callbacks detach their DomainStore and metadata
relation scopes. PostgreSQL tests check these boundaries with pool sizes one
and two and retain SQL cohorts until callback completion.

Worker objects/counts, idle cleanup timing, cross-thread callback interleaving
and retaining old runner capacity after configuration changes are diagnostics.
The native dispose result precedes active callback completion; its queued
completion signals do not report 100. Node follows the runtime's existing
drain-before-dependency-close contract and releases every owned sequence before
returning from close. Late progress from a completed callback cannot reopen a
finished workset. No CLR thread/timer implementation is reproduced.

Older queued slots are dispatched before later slots in the gated recording,
but the next workset starts while prior callbacks remain active. This is not a
guarantee of atomic workset fairness across concurrent native writers.
