# Library directory monitor policy

`native.json` is the unmodified output of the designated workspace build's real `LibraryMonitor` and `FileRefresher`. `Program.cs` invokes explicit change reports against real isolated directories and the real `ManagedFileSystem` and `.ignore` reader. Timer callbacks are invoked directly after the change reports; lookup and `ChangedExternally` are controlled boundaries. `provenance.json` binds the input, helper, recording, execution receipt, designated sources and the independently sealed native build.

The fourteen cases cover duplicate and sibling changes, parent rebasing, first matching refresher selection, raw prefixes, case-sensitive sibling-parent matching, temporary self-write suppression, static and `.ignore` filters, lookup failure continuation, item-ID deduplication, AggregateFolder exclusion, per-item refresh failure continuation, and Stop discarding pending timers. Replay compares event filtering/invalidation order and every batch's complete ordered lookup/refresh effects. Separate timer batches are unordered because the oracle explicitly invokes independent callbacks without claiming an operating-system scheduling order.

`library-directory-monitor.test.js` additionally controls timers and asynchronous watch creation to check the forty-five-second suppression expiry, generation changes, permission/other errors, event subscriptions, cancellation, retained item owners and shutdown draining. These tests do not prove actual watcher delivery, production PostgreSQL lookup, the complete provider dispatch, a real forty-five-second wait or release acceptance. The recording is Windows evidence; portable replay does not turn it into Linux or macOS native evidence.

The referenced Jellyfin sources retain their GPL-2.0 license.
