# XMLTV listings package

This official Node package registers the same `listings` extension used by installed third-party packages. It receives native `ListingsProviderInfo` values from the Live TV source manager; its package settings are empty. `connect()` supplies the metadata storage mapping and the server metadata language. The provider exposes `type: 'xmltv'`, `name: 'XmlTV'`, and its read-only owned `cachePath`.

The implementation follows the designated workspace's `src/Jellyfin.LiveTv/Listings/XmlTvListingsProvider.cs` and `XmlTvProgramEtag.cs`. XML reader behavior follows `Jellyfin.XmlTv` `10.12.0-pre1`, source commit `6c8c302c8520e5f41cd51dd392ac631f97179d82` in [Jellyfin.XmlTv](https://github.com/jellyfin/Jellyfin.XmlTv/tree/6c8c302c8520e5f41cd51dd392ac631f97179d82). These adaptations retain the repository's GPL-2.0-only license.

## Source access and cache

Local source paths resolve through `metadataIdentityMap` and `metadataVfs`. An existing host file without a mapping is unavailable. Only the owned cache uses direct filesystem access, under the host's general `cachePath/xmltv`, separate from image-cache overrides. A host without an application cache root uses the package's owned temporary cache directory.

Each native provider identity selects `<Id>.xml` and its fixed `<Id>.xml.tmp` temporary file. Fresh cache entries last one hour. Remote failures are remembered for one hour by the exact configured source path; a stale cache can satisfy a failed refresh. `validate()` clears that source's failure record. XML parsing happens after caching, so malformed fresh XML remains cached until expiry or explicit source-manager invalidation. Successful cache writes retain the exact downloaded or decompressed bytes.

Remote paths use the native `http` prefix check, HTTP success validation and redirects. Gzip is selected by the final response URL's `.gz` or `.gzip` extension before its query, rather than content type. As in the reference, a gzip copy failure may retain a nonempty decompressed prefix; the XML reader then judges that file. The configured download limit is fifteen minutes. Caller cancellation removes its temporary file and does not enter failure backoff. Provider shutdown rejects new work, cancels admitted I/O and waits for its source and file owners to close.

Two deliberate safety differences remain subject to consumer review. Cache identities containing `/`, `\`, NUL or `:` are rejected before source access, preventing directory escape and Windows alternate streams. Valid non-GUID identities retain their original value. A rejected concurrent writer cannot unlink a temporary file owned by another admitted writer; abandoned temporary files can still be removed. The native provider does not establish these two boundaries. These differences are not a claim of full functional alignment or release acceptance.

## Reader and mapped values

The reader preserves the designated parser's language-group selection, category order, channel-number selection, partial XMLTV dates and offsets, exact range boundaries, episode/show identity rules, movie overrides, optional list behavior, first image/rating selection and adjacent-node advancement. DTDs are ignored without loading external resources or defining entities. XML byte encodings are decoded before the shared XML cursor validates the document. UTC values retain 100ns precision; programme identity uses the original offset with seven fractional digits.

`program-etag.js` fingerprints mapped `ProgramInfo` fields with the native length-prefixed schema, ordered collections, ordinal dictionary order, UTC dates and binary32 round-trip text. A stored-match candidate requires the exact lowercase `xmltv-sha256-v1:` prefix, followed by ordinal-insensitive whole-value equality.

This package supplies source channels, lineups and programmes. Guide database materialization, refresh scheduling and source configuration invalidation belong to their host consumers. It exposes no recording or transcoding executor.

## Evidence scope

The following tests are ready for remote validation; their presence does not imply they have passed:

- `tests/plugins/xmltv-etag.test.js` invokes the actual internal native Etag helper, including null/error gates, collection order, unknown audio values and binary32 boundaries.
- `tests/plugins/xmltv-reader-provider.test.js` invokes the actual designated provider and pinned reader. It compares channel/programme/lineup values, native `ParseDate`, error propagation, cache bytes and file cleanup, including encodings and malformed input.
- `tests/plugins/xmltv-cache.test.js` uses a real isolated HTTP server for native and Node downloads, redirects, gzip, stale-cache fallback, backoff, validation retry and cancellation after body admission. The HttpClient timeout exception is injected at the HTTP handler boundary; this does not prove an elapsed fifteen-minute timeout. It records request and resource ledgers.
- `tests/plugins/xmltv.test.js` loads installed and official packages through `PluginHost`, exercises mapped and unmapped real files, checks cache-identity rejection, holds concurrent real temporary-file writes and verifies shutdown waits for the admitted source owner.

The native oracle records input/output and actual assembly hashes, versions, parser pin and private-input cleanup. Differential tests require `dotnet` and the designated `jellyfinDll`; production code has no .NET dependency. Phase and release acceptance remain false until their separate complete acceptance runs.
