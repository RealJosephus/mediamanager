# Archive access and owned worker lifetime

The ZIP catalog, exact lookup and selected-byte comparisons consume the two independent current OPF/EPUB native captures. All five archive inputs also match their original tracked ZIP bytes. Original recordings and their external build provenance remain unchanged.

Cancellation, repeated reads, terminal worker failures and shutdown continue through the actual archive service. The encrypted-entry termination case uses the original SharpCompress encrypted RAR recovered at its original SHA-256, then stalls after the real derived spool is prepared. It checks that forced worker termination removes both original and derived spools and that every media stream is closed. This is an owned Node worker failure test, not an additional native encryption or metadata recording.
