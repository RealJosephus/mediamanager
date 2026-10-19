# Frozen owned-item lifecycle oracle

Recorded using the isolated current-workspace Jellyfin assemblies, with raw source, input and assembly identities in `provenance.json`.

The native `BaseItem.RefreshMetadata` wrapper and `Video.RefreshedOwnedItems` execute, including real title/date mutations, version mixed import, primary repair, link/count handling, missing-path decisions and the error boundary. Discovery results, identities, file existence, provider dispatch and repository/image/link/delete effects are explicit controls, not native SQL or a full library scan.

The candidate dispatch comparison covers all 17 recorded scenarios, including controlled extra rename, missing part deletion, missing alternate-path cleanup and already-cancelled child dispatch. Native FindExtras and first-extra repository saves have separate fixtures. The real SQLite/PostgreSQL integration tests exercise independent persistence, probe reload preservation, stale relationships, cycle rejection, missing-part file cleanup/SQL rollback, cancellation before the owner provider and later SaveItems orphan deletion. Native deletion effects are controlled in this oracle; the database helper has separate native evidence. This is not full discovery, general DeleteItem or release acceptance.
