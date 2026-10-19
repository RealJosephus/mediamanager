import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { decodeValue } from '../database/values.js';
import { collectionType } from './user-view-query.js';
import { mapRecord } from './records.js';
import { releaseNativeItemLinks } from './native-item-entity.js';

const columns = tableDefinition('BaseItems').columns;
const itemTypes = {
  movies: ['Movie'], tvshows: ['Series'], music: ['MusicArtist'], musicvideos: ['MusicVideo'],
  books: ['Book', 'AudioBook'], boxsets: ['BoxSet'], homevideos: ['Video', 'Photo'],
  photos: ['Video', 'Photo'], folders: []
};
const defaultTypes = ['Video', 'Audio', 'Photo', 'Movie', 'Series'];

/** Collection posters choose at most eight items before resolving their local
 * artwork. Missing local images do not cause a second query or backfilling. */
export function withCollectionFolderImageCandidates(library, folder, operation) {
  const type = collectionType(folder);
  return library.withItemQueryPlan({ ParentId: folder.Id, Recursive: type !== 'playlists',
    CollapseBoxSetItems: false, IncludeItemTypes: itemTypes[type] ?? defaultTypes,
    ImageTypes: ['Primary'], Limit: 8, SortBy: 'Random', SortOrder: 'Ascending',
    EnableImages: false, EnableUserData: false, EnableTotalRecordCount: false }, {}, async (db, plan) => {
    const sql = nativeTextSql(db.schemaName), items = `${q(db.schemaName)}."BaseItems"`;
    const images = `${q(db.schemaName)}."BaseItemImageInfos"`;
    const rows = (await db.client.query({ text: `/* collection-folder-image-candidates */
      WITH chosen AS MATERIALIZED (${plan.text})
      SELECT item.*,first_local."Path" AS "__imagePath" FROM chosen
      JOIN ${items} item ON ${sql.guidKey('item."Id"')}=${sql.guidKey('chosen."Id"')}
      LEFT JOIN LATERAL (
        SELECT first_image."Path" FROM (
          SELECT DISTINCT ON (image."ImageType") image."ImageType",image."Path"
          FROM ${images} image JOIN ${q(db.controlSchema)}."image_order" sequence ON sequence.image_id=image."Id"
          WHERE image."ItemId"=item."Id" AND image."ImageType" IN (0,2,5)
          ORDER BY image."ImageType",sequence.position
        ) first_image WHERE ${sql.projection('first_image."Path"')} !~* '^http'
          AND octet_length(first_image."Path")>0
        ORDER BY CASE first_image."ImageType" WHEN 2 THEN 0 WHEN 0 THEN 1 ELSE 2 END LIMIT 1
      ) first_local ON TRUE ORDER BY chosen."__ordinal"`, values: plan.values })).rows;
    const selected = [];
    // GetItemList hydrates its selected result before collage creation. There
    // are at most eight records, including any typed-data failures.
    for (const row of rows) {
      const item = mapRecord(Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
      if (!item) continue;
      releaseNativeItemLinks(item);
      selected.push(row.__imagePath == null ? null : decodeNativeTextBytes(row.__imagePath));
    }
    return operation({
      async hasItems() { return selected.length !== 0; },
      async *paths() {
        for (const filename of selected) if (filename) yield library.options.expandPath?.(filename) ?? filename;
      }
    });
  });
}
