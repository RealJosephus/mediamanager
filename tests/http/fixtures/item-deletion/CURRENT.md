# Current Item DELETE validation

`current-profile.json` binds the neutral input, Oracle source/project and shared build properties used with the same-run designated Native runtime. The current release tests compare public HTTP responses, action ordering, permission outcomes and PostgreSQL deletion state; CLR diagnostics, assembly inventories and build intermediates are not product gates.

The recorder preserves the original response body and trace identifier. Both Native and Node observations use `tests/http/deletion-response-projection.js`, which accepts a nonempty opaque string and replaces only the top-level JSON trace value after binding it to the actual body. Status, error details, action order, committed state and all bytes outside that value remain exact. The historical format-specific normalizer remains sealed and is not used by current consumers.

`provenance.json`, `native.json` and the hash-bound historical `README.md` retain the 2026-10-10 capture unchanged. Its external raw recordings and old runtime are incomplete, are not backfilled and are not used by the current gate. This current slice does not claim state-package exchange or final release acceptance.
