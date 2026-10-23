import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { postgresColumnType } from '../database/native-text-sql.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeDate } from '../sessions/user-data.js';
import { cleanValue, EMPTY_ID, nonemptyId } from './records.js';
import { nativeItemDescriptor } from './native-item-entity.js';
import { imageTypes } from '../metadata/image-paths.js';

const columns = tableDefinition('BaseItems').columns;
const dates = new Set(['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved',
  'DateLastMediaAdded', 'EndDate', 'PremiereDate', 'StartDate']);
const lists = ['Genres', 'Tags', 'Studios', 'Artists', 'AlbumArtists', 'ProductionLocations'];
const episodeOrderFields = ['AirsAfterSeasonNumber', 'AirsBeforeSeasonNumber', 'AirsBeforeEpisodeNumber'];
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample',
  'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const audioTypes = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];
const bytes = value => value == null ? null : nativeTextBytes(value);
const queryColumns = [...columns.map(column => column.name), '__Occurrence', '__SlotKey',
  ...lists.map(name => '__' + name), '__ProviderKeys', '__ProviderValues', '__ImageTypes', '__LibraryFolderIds',
  ...episodeOrderFields.map(name => '__' + name), '__LinkedChildrenNull'];

export function nativeItemQueryColumns(alias) {
  return queryColumns.map(name => `${alias}.${q(name)}`).join(',');
}

/** Query columns describe a live object, not a new persistence image. Keep
 * typed lists separate from the repository's lossy pipe columns and never run
 * the full Data/DTO serializer before SQL has chosen the response page. */
export async function createPostgresNativeItemQueryProjection(session) {
  const table = q('mm_native_query_' + randomUUID().replaceAll('-', ''));
  const additional = ['"__Occurrence" bigint PRIMARY KEY', '"__SlotKey" uuid NOT NULL',
    ...lists.map(name => `${q('__' + name)} bytea[]`), '"__ProviderKeys" bytea[]', '"__ProviderValues" bytea[]',
    '"__ImageTypes" integer[]', '"__LibraryFolderIds" jsonb', ...episodeOrderFields.map(name => `${q('__' + name)} integer`),
    '"__LinkedChildrenNull" boolean NOT NULL'];
  await session.client.query(`CREATE TEMP TABLE ${table} (${columns.map(column => `${q(column.name)} ${postgresColumnType(column)}`).concat(additional).join(',')})`);
  // Replacement collections may be outside the captured Folder. Their rows
  // remain in PostgreSQL until the final page, with no captured entity slot.
  const repository = Object.freeze({ text: `SELECT ${columns.map(column => `source.${q(column.name)}`).join(',')},
    0::bigint AS "__Occurrence", NULL::uuid AS "__SlotKey",
    ${lists.map(name => `NULL::bytea[] AS ${q('__' + name)}`).join(',')},
    NULL::bytea[] AS "__ProviderKeys", NULL::bytea[] AS "__ProviderValues", NULL::integer[] AS "__ImageTypes",
    NULL::jsonb AS "__LibraryFolderIds", ${episodeOrderFields.map(name => `NULL::integer AS ${q('__' + name)}`).join(',')},
    FALSE AS "__LinkedChildrenNull",
    0::bigint AS "__SourceOrdinal" FROM ${q(session.schemaName)}."BaseItems" source`,
  values: Object.freeze([]) });
  let closed = false;
  return Object.freeze({ table, plan() {
    if (closed) throw new Error('The live item query projection has closed.');
    return Object.freeze({ text: `SELECT *, "__Occurrence" AS "__SourceOrdinal" FROM ${table}`, values: Object.freeze([]), repository });
  }, async append(item, slot, ordinal) {
    if (closed) throw new Error('The live item query projection has closed.');
    const descriptor = nativeItemDescriptor(item.NativeType), values = [];
    for (const column of columns) {
      const name = column.name;
      let value = name === 'Type' ? item.NativeType : name === 'CleanName' ? cleanValue(item.Name)
        : name === 'Data' ? null : lists.includes(name) ? null : item[name];
      if (name === 'ParentId' || name === 'OwnerId' || name === 'PrimaryVersionId') value = nonemptyId(value) ? value : null;
      if (name === 'IsFolder') value = descriptor.family === 'folder' && item.IsFolder;
      if (name === 'ChannelId') value ??= EMPTY_ID;
      if (dates.has(name) && value != null) value = nativeDate(value);
      if (name === 'ExtraType' && typeof value === 'string') value = extraTypes.indexOf(value);
      if (name === 'Audio' && typeof value === 'string') value = audioTypes.indexOf(value);
      if (value == null) value = column.nullable ? null : column.type === 'TEXT' ? '' : column.clrType === 'bool' ? false : 0;
      // PostgreSQL can carry Single NaN/Infinity until the native comparison or
      // selected DTO consumes it. Persistence's finite-only encoder cannot.
      values.push(column.type === 'TEXT' ? bytes(value) : typeof value === 'bigint' ? value.toString() : value);
    }
    const names = columns.map(column => q(column.name));
    names.push('"__Occurrence"', '"__SlotKey"'); values.push(ordinal, slot);
    for (const name of lists) { names.push(q('__' + name)); values.push(item[name]?.map(bytes) ?? null); }
    names.push('"__ProviderKeys"', '"__ProviderValues"', '"__ImageTypes"', '"__LibraryFolderIds"');
    const providers = item.ProviderIds == null ? null : Object.entries(item.ProviderIds);
    values.push(providers?.map(([name]) => bytes(name)) ?? null, providers?.map(([, value]) => bytes(value)) ?? null,
      item.ImageInfos?.map(image => typeof image.Type === 'number' ? image.Type : imageTypes.indexOf(image.Type)) ?? null,
      item.LibraryFolderIds == null ? null : JSON.stringify(item.LibraryFolderIds));
    for (const name of episodeOrderFields) { names.push(q('__' + name)); values.push(item[name] ?? null); }
    names.push('"__LinkedChildrenNull"'); values.push(descriptor.family === 'folder' && item.LinkedChildren === null);
    await session.client.query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${values.map((_, index) => '$' + (index + 1)).join(',')})`, values);
  }, async close() {
    if (closed) return; closed = true;
    await session.client.query(`DROP TABLE ${table}`);
  } });
}
