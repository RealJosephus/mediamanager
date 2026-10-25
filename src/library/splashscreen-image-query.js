import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';

const types = { Primary: 0, Thumb: 5, Backdrop: 2 };

/** Select no more than 30 random items, then read each item's first image by ID.
 * Empty first paths are excluded after the item limit, matching the task. */
export async function querySplashscreenImagePaths(database, imageType) {
  if (!Object.hasOwn(types, imageType)) throw new TypeError('Splashscreen selection requires Primary, Thumb or Backdrop.');
  const plan = buildPostgresItemPageQuery(database, {
    recursive: true, includeitemtypes: ['Movie', 'Series'], imagetypes: [imageType],
    maxparentalrating: { score: 13, subScore: null }, limit: 30,
    sortby: ['Random'], sortorder: ['Ascending'],
  }, { includeOrdinal: true, groupByPresentationKey: false });
  const sql = nativeTextSql(database.schemaName);
  const images = `${q(database.schemaName)}.${q('BaseItemImageInfos')}`;
  const rows = (await database.client.query({ text: `/* splashscreen-image-selection */
    WITH chosen AS MATERIALIZED (${plan.text})
    SELECT first_image."Path" FROM chosen
    CROSS JOIN LATERAL (
      SELECT image."Path" FROM ${images} image
      WHERE ${sql.guidKey('image."ItemId"')} = ${sql.guidKey('chosen."Id"')} AND image."ImageType" = $${plan.values.length + 1}
      ORDER BY image."Id" LIMIT 1
    ) first_image
    WHERE chosen."Id" IS NOT NULL AND first_image."Path" IS NOT NULL AND octet_length(first_image."Path") > 0
    ORDER BY chosen."__ordinal"`, values: [...plan.values, types[imageType]] })).rows;
  return rows.map(row => decodeNativeTextBytes(row.Path));
}
