# XMLTV listings

Configure each XMLTV source in Live TV. The plugin registers the `xmltv` listings provider and reads its native `ListingsProviderInfo`. The provider uses the server’s current preferred metadata language as the fallback. The host manages guide rows and schedules refreshes. [Live TV extension contract](../../packages/plugin-sdk/live-tv/README.md)

## Source and cache

Local sources use the metadata VFS identity map. A mapped Windows share accepts either slash spelling. HTTP sources follow redirects and select gzip from the final URL’s `.gz` or `.gzip` suffix before the query string. The download timeout is 15 minutes. A failed gzip transfer discards the temporary file. A previously published copy can satisfy the read. [Source and cache code](provider.js)

Both local and HTTP sources store the copied or decompressed bytes in `<Id>.xml`. A cache entry is fresh for one hour. After a failed refresh, the provider can serve a stale copy. Remote retry backoff lasts one hour and uses the exact source path. Validating the source clears its failure record. A caller cancellation removes the writer’s `<Id>.xml.tmp` and allows an immediate retry. IDs containing a path separator, NUL or colon are rejected. An admitted writer owns its temporary file until it closes. [Cache tests](../../tests/plugins/xmltv-cache.test.js)

To reload an edited guide, clear the plugin cache with `DELETE /Plugins/xmltv/Cache`, then query the saved provider’s lineups. Clearing drains active provider work and removes `<Id>.xml` and `<Id>.xml.tmp` for configured XMLTV IDs, including when the plugin is disabled. It uses the configured filesystem and cache root, normally the application’s `cachePath/xmltv`. Unrelated files in a shared guide cache survive. The host also clears the plugin’s private cache directory. [Cache implementation](index.js) · [Source management tests](../../tests/plugins/xmltv-source-management.test.js)

## Native comparison

The mapping follows Jellyfin’s `XmlTvListingsProvider.cs` and `XmlTvProgramEtag.cs` and the pinned Jellyfin.XmlTv reader 10.12.0-pre1. The adaptations retain the project’s GPL-2.0-only license. [Reader source](https://github.com/jellyfin/Jellyfin.XmlTv/tree/6c8c302c8520e5f41cd51dd392ac631f97179d82)

| Contract | Regression |
| --- | --- |
| XML decoding, language and category order, channel numbers, partial dates, range boundaries and episode identity. Programme IDs retain the source offset and seven fractional digits. | [Provider and reader](../../tests/plugins/xmltv-reader-provider.test.js) |
| ProgramInfo fingerprints use the native length-prefixed encoding, ordered collections and binary32 values. Matching requires the lowercase `xmltv-sha256-v1:` prefix and ordinal case-insensitive equality of the full value. | [Program Etag](../../tests/plugins/xmltv-etag.test.js) |
| Installed packages, mapped paths, concurrent writers and shutdown. | [Plugin host](../../tests/plugins/xmltv.test.js) |

Native comparisons require `dotnet` and the designated `jellyfinDll`. The timeout test injects the HTTP handler exception.
