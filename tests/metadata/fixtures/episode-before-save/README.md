# Frozen Episode before-save controls

`native.json` is unchanged actual `EpisodeMetadataService` output from
`.agent-docs/evidence/episode-before-save-native-audit-v1/native-changed-provider.json`.
SHA-256: `5ad5dcc1487cf3f6fd0d85f134c04bd3bfafab2ace8f66c5f208b1f97433951e`.

Eight controls cover existing/first None/Default refreshes with initial
orphaned/reversed/valid ranges and providers introducing new invalid ranges.
The real subclass corrects the initial range before first repository save and
provider fetch. It preserves an invalid range newly introduced by that refresh's
provider. Candidate tests compare update reasons, ordered saves/providers,
range fields, and committed SQLite/PostgreSQL state mechanically.

The native service controls dependency callbacks, parent/season absence,
repository saves and reattachment; it executes no native SQL or HTTP. Candidate
comparison includes the recorded reattach event and its position after the final
save. Native reattachment SQL, MinValue save timestamps, complete Episode parent
hydration and other typed Before/After hooks remain outside this fixture.
