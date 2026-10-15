import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { idKey } from './records.js';
import { nativeItemTypes } from './native-item-entity.js';

/** The recursive album query selects one item before inspecting its image path. */
export async function queryPhotoAlbumCover(database, albumId) {
  if (database?.dialect !== 'postgres') throw new TypeError('Photo album cover selection requires PostgreSQL.');
  const sql = nativeTextSql(database.schemaName);
  const table = name => `${q(database.schemaName)}.${q(name)}`;
  const result = await database.client.query({ text: `/* photo-album-cover-selection */
    WITH selected AS MATERIALIZED (
      SELECT item."Id", item."Path", item."Type"
      FROM ${table('BaseItems')} item
      WHERE EXISTS (
        SELECT 1 FROM ${table('AncestorIds')} ancestor
        WHERE ${sql.guidKey('ancestor."ItemId"')} = ${sql.guidKey('item."Id"')}
          AND ${sql.guidKey('ancestor."ParentItemId"')} = $1::text
      )
        AND ${sql.guidKey('item."Id"')} <> '00000000000000000000000000000001'
        AND EXISTS (SELECT 1 FROM ${table('BaseItemImageInfos')} image
          WHERE ${sql.guidKey('image."ItemId"')} = ${sql.guidKey('item."Id"')} AND image."ImageType" = 0)
        AND (item."OwnerId" IS NULL OR item."ExtraType" IS NOT NULL)
        AND (item."PrimaryVersionId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${table('BaseItems')} primary_item
          WHERE ${sql.guidKey('primary_item."Id"')} = ${sql.guidKey('item."PrimaryVersionId"')}
            AND ${sql.guidKey('primary_item."TopParentId"')} IS NOT DISTINCT FROM ${sql.guidKey('item."TopParentId"')}
        ))
      ORDER BY item."IsFolder" ASC, item."SortName" ASC NULLS FIRST, item."Id" ASC
      LIMIT 1
    )
    SELECT selected."Id", selected."Path", selected."Type", first_image."Path" AS "ImagePath"
    FROM selected
    CROSS JOIN LATERAL (
      SELECT image."Path" FROM ${table('BaseItemImageInfos')} image
      WHERE ${sql.guidKey('image."ItemId"')} = ${sql.guidKey('selected."Id"')} AND image."ImageType" = 0
      ORDER BY image."Id" ASC LIMIT 1
    ) first_image`, values: [idKey(albumId)] });
  const row = result.rows[0];
  if (!row) return null;
  const decode = value => value == null ? null : decodeNativeTextBytes(value);
  const nativeType = decode(row.Type);
  if (!nativeItemTypes.includes(nativeType)) return null;
  return { Id: decode(row.Id), Path: decode(row.Path), Type: nativeType.split('.').at(-1), ImagePath: decode(row.ImagePath) };
}
