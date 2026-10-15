# Native owned-item metadata refresh

The oracle invokes the frozen DLL's actual protected `BaseItem.RefreshMetadataForOwnedItem` and internal `InheritDatesFromOwner` methods. Native Movie, Video, Trailer and Audio entities exercise ordinal array/scalar comparisons, lock bypass, null/date behavior, 100 ns precision, independent child metadata, option copying and cancellation forwarding. Child `RefreshMetadata` runs with no physical parent and a controlled `ProviderManager.RefreshSingleItem` callback that records its exact input.

The fixture does not cover filesystem discovery, owned-row creation/deletion, providers, probe, images, savers, persistence, the full owner refresh or complete library acceptance. Candidate integration must verify those scopes separately.
