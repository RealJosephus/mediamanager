# Photo runtime integration

The Node test joins the actual built-in registry, metadata host, PostgreSQL persistence, authenticated item and image HTTP, static image orientation and PhotoAlbum cover copying. It uses the rich combined JPEG from the separately sealed Photo provider fixture. It verifies the original bytes remain unchanged and the album cover is stored internally even when local metadata saving is enabled.

A second case uses the actual configured local plugin with distinct media, nested media and metadata bindings. Different decoy images occupy the parent and metadata backends at the same identity. Refresh, cold DTO dimensions and album copying must use the nested media original; all backend bytes and SQL image dimensions remain unchanged by the DTO query.

Embedded values and dates come from the actual native Photo provider observation. The provider's live duplicate tags become first-occurrence OrdinalIgnoreCase values on repository reload, following the bound BaseItemMapper implementation and existing native list-column fixture. The Photo DTO and album fixtures independently bind their native observations. This integration does not execute a complete native HTTP refresh or claim full scanning, client or release acceptance.
