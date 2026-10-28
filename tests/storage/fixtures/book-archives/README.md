# Archive access and owned worker lifetime

The ZIP catalog, exact lookup and selected-byte comparisons consume the two independent current OPF/EPUB native captures. All five archive inputs also match their original tracked ZIP bytes. Original recordings and their external build provenance remain unchanged.

Cancellation, repeated reads, terminal worker failures and shutdown continue through the actual archive service. The encrypted-entry termination case uses the original SharpCompress encrypted RAR recovered at its original SHA-256, then stalls after the real derived spool is prepared. It checks that forced worker termination removes both original and derived spools and that every media stream is closed. This is an owned Node worker failure test, not an additional native encryption or metadata recording.

The archive failure matrix reads actual source files and captures the real
spooled prefix before source cleanup completes. Source failures, cancellation
and source-close failures retain their original values, including falsy reasons;
cleanup drains the source, destination and both spool names in order. The worker
cases use the production archive worker and real ZIP reads or initialization
failure. Controlled termination failures occur after the actual thread exits.
Two real directory collisions exercise both failed spool removals, followed by
explicit fixture recovery. Shutdown waits for both real readers even when their
terminations reject, including a reader that finishes while a separate opening
is still draining. Shutdown also reports cleanup failures from its active
openings; ordinary lifetime cancellation by itself still permits clean shutdown.
Functional assertions keep message/code/status/cause and
ordered errors; Error name/stack remain diagnostics. Retained reports and copied
spool bytes are separate from final fixture disposal. JSON retains its normal
undefined limitations; precise reason comparisons run before serialization.
