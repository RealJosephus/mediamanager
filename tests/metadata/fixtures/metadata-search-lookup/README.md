# Metadata provider lookup inputs

The oracle calls the specified workspace's actual Movie, Season and Episode metadata services with a controlled provider. It records the lookup object received by that provider and the overview returned through the native metadata merge. The candidate test runs the same provider consumer through MetadataRefreshHost and real PostgreSQL persistence.

The 15 scenarios cover manual/automated refresh, Identify name/year and replacement IDs, null search values, and the distinct validation/normalization used by ordinary item IDs and TV Series IDs. TV identification leaves the episode/season name and year in the lookup and replaces SeriesProviderIds while clearing item ProviderIds. Movie Identify uses ProductionYear as Year. Search inputs remain unchanged.

Items are pathless and explicitly mixed. Options, children, filesystem, repository and native provider callbacks are controlled. This fixture does not establish public Identify routes, SQL parity of the native service, sidecar/image behavior, external provider behavior or complete MetadataService coverage.

`current-profile.json` binds the tracked scenario and Oracle sources used with the same-run designated Native runtime; the release test compares that current functional observation with the Node provider and PostgreSQL result. `provenance.json` and `native.json` retain the 2026-10-15 recording unchanged as historical material. Its external execution record and old runtime are not all present, so that archival closure remains incomplete and is not backfilled or used as the current release gate.
