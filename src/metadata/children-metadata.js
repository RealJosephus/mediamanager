import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { dateTicks, MIN_DATE } from '../library/records.js';
import { getRatingScore } from '../core/localization-data.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { ItemUpdateType } from './save-manager.js';
import { trySetProviderId } from './provider-ids.js';
import { clrTrim } from './whitespace.js';

const cumulativeTypes = new Set(['MusicAlbum', 'MusicArtist']);
const premiereTypes = new Set(['MusicAlbum', 'Season', 'BoxSet']);
const genreTypes = new Set(['MusicAlbum', 'MusicArtist', 'BoxSet', 'Playlist']);
const studioTypes = new Set(['MusicAlbum', 'BoxSet', 'Playlist']);
const ratingTypes = new Set(['BoxSet', 'Playlist']);
const maxDateTicks = dateTicks('9999-12-31T23:59:59.9999999Z'), minDateTicks = dateTicks(MIN_DATE);
const comparer = new Intl.Collator(undefined, { sensitivity: 'variant' });
const compareText = (left, right) => left == null ? right == null ? 0 : -1 : right == null ? 1 : comparer.compare(left, right);
const sequenceEqual = (left, right, equals = (a, b) => a === b) => left.length === right.length && left.every((value, index) => equals(value, right[index]));
const decode = value => value == null ? null : decodeNativeTextBytes(value);

export function requiresMetadataChildren(item, isFullRefresh, currentUpdateType) {
  if (!isFullRefresh && currentUpdateType === ItemUpdateType.None) return item.Type === 'Series';
  return isFullRefresh || currentUpdateType > ItemUpdateType.None
    ? item.Type === 'Series' || cumulativeTypes.has(item.Type) || premiereTypes.has(item.Type) || genreTypes.has(item.Type) : false;
}

/** Membership and value-frequency state stay in SQL. Only the final native
 * metadata arrays are returned whole; the child list and candidate ratings are
 * never retained in Node. The caller owns and finally closes the sequence. */
export async function updateMetadataFromChildren(item, children, isFullRefresh, currentUpdateType,
  { ratingScore = getRatingScore, defaultCountry = 'US' } = {}) {
  if (typeof children?.pages !== 'function' || typeof children.aggregationSession !== 'function') throw new TypeError('Metadata aggregation requires an owned typed child sequence.');
  let updateType = ItemUpdateType.None;
  const change = (field, value, reason, equals = (a, b) => (a ?? null) === (b ?? null)) => {
    const changed = !equals(item[field], value); item[field] = value; if (changed) updateType |= reason;
  };
  const full = isFullRefresh || currentUpdateType > ItemUpdateType.None;
  let count = 0n, runtime = 0n, latest = MIN_DATE, premiere = null, premiereTicks = maxDateTicks, year = Infinity, allVirtual = true, albumName;
  for await (const page of children.pages()) {
    if (page.length > 128) throw new RangeError('Metadata child pages cannot exceed 128 items.');
    for (const child of page) {
      count++;
      if (!child.IsFolder && !child.IsVirtualItem && dateTicks(child.DateCreated) > dateTicks(latest)) latest = child.DateCreated;
      if (!child.IsFolder) runtime = BigInt.asIntN(64, runtime + BigInt(child.RunTimeTicks ?? 0));
      const current = child.PremiereDate == null ? maxDateTicks : dateTicks(child.PremiereDate);
      if (current < premiereTicks) { premiere = child.PremiereDate; premiereTicks = current; }
      year = Math.min(year, child.ProductionYear ?? 0);
      allVirtual &&= child.LocationType === 'Virtual';
      if (albumName === undefined && child.Album != null && child.Album !== '') albumName = child.Album;
    }
  }
  if (item.Type === 'Series') change('DateLastMediaAdded', latest, ItemUpdateType.MetadataImport,
    (left, right) => left != null && dateTicks(left) === dateTicks(right));
  if (full && cumulativeTypes.has(item.Type)) change('RunTimeTicks', runtime, ItemUpdateType.MetadataImport,
    (left, right) => left != null && BigInt(left) === right);

  if (full && !item.IsLocked) await children.aggregationSession(async (session, { plan }) => {
    const sql = nativeTextSql(session.schemaName);
    const source = `(${plan.text}) children`;
    const finalValues = async query => {
      const values = [];
      for (let after = 0n; ;) {
        const rows = (await session.client.query(`SELECT * FROM (${query}) output WHERE ordinal>$1 ORDER BY ordinal LIMIT 128`, [after])).rows;
        if (!rows.length) return values;
        for (const row of rows) values.push(decode(row.value));
        after = BigInt(rows.at(-1).ordinal);
      }
    };
    if (premiereTypes.has(item.Type) && count) {
      if (premiereTicks > minDateTicks && premiereTicks < maxDateTicks) {
        change('PremiereDate', premiere, ItemUpdateType.MetadataEdit, (left, right) => dateTicks(left) === dateTicks(right));
        change('ProductionYear', Number(premiere.slice(0, 4)), ItemUpdateType.MetadataEdit);
      } else if (year > 0) change('ProductionYear', year, ItemUpdateType.MetadataEdit);
    }
    for (const [field, types] of [['Genres', genreTypes], ['Studios', studioTypes]]) {
      if (!types.has(item.Type) || (item.LockedFields ?? []).includes(field)) continue;
      const values = await finalValues(`WITH occurrences AS (SELECT children."Ordinal",value.position,value.text AS value,
        ${sql.ordinalIgnoreCaseKey('value.text')} AS key FROM ${source} CROSS JOIN LATERAL unnest(children.${q(field)}) WITH ORDINALITY value(text,position)),
        firsts AS (SELECT DISTINCT ON(key) * FROM occurrences ORDER BY key,"Ordinal",position)
        SELECT value,row_number() OVER(ORDER BY "Ordinal",position) AS ordinal FROM firsts`);
      const previous = item[field] ?? [];
      change(field, values, ItemUpdateType.MetadataEdit, () => sequenceEqual([...previous].sort(compareText), [...values].sort(compareText), ordinalIgnoreCaseEquals));
    }
    if (ratingTypes.has(item.Type) && !(item.LockedFields ?? []).includes('OfficialRating')) {
      const ratings = q('mm_metadata_ratings_' + randomUUID().replaceAll('-', ''));
      await session.client.query(`CREATE TEMP TABLE ${ratings} AS SELECT DISTINCT ON(${sql.ordinalIgnoreCaseKey('"OfficialRating"')})
        "Ordinal", "OfficialRating" AS value,NULL::integer AS score,NULL::integer AS subscore FROM ${source}
        WHERE "OfficialRating" IS NOT NULL AND octet_length("OfficialRating")>0
        ORDER BY ${sql.ordinalIgnoreCaseKey('"OfficialRating"')},"Ordinal"`);
      try {
        for (let after = 0n; ;) {
          const rows = (await session.client.query(`SELECT * FROM ${ratings} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
          if (!rows.length) break;
          for (const row of rows) {
            const score = ratingScore(decode(row.value), item.MetadataCountryCode, defaultCountry);
            await session.client.query(`UPDATE ${ratings} SET score=$2,subscore=$3 WHERE "Ordinal"=$1`, [row.Ordinal, score == null ? 1001 : score.score, score == null ? 1001 : score.subScore]);
          }
          after = BigInt(rows.at(-1).Ordinal);
        }
        const selected = (await session.client.query(`SELECT value FROM ${ratings} ORDER BY score,subscore NULLS FIRST,"Ordinal" LIMIT 1`)).rows[0];
        if (selected) change('OfficialRating', decode(selected.value), ItemUpdateType.MetadataEdit,
          (left, right) => ordinalIgnoreCaseEquals(left ?? '', right ?? ''));
      } finally { await session.client.query(`DROP TABLE ${ratings}`); }
    }
    if (item.Type === 'MusicAlbum') {
      if (albumName != null && !(item.LockedFields ?? []).includes('Name')) change('Name', albumName, ItemUpdateType.MetadataEdit);
      for (const field of ['Artists', 'AlbumArtists']) {
        const values = await finalValues(`WITH occurrences AS (SELECT children."Ordinal",value.position,value.text AS value,
          ${sql.ordinalIgnoreCaseKey('value.text')} AS key FROM ${source} CROSS JOIN LATERAL unnest(children.${q(field)}) WITH ORDINALITY value(text,position)),
          counted AS (SELECT *,count(*) OVER(PARTITION BY key) AS count,row_number() OVER(PARTITION BY key ORDER BY "Ordinal",position) AS first FROM occurrences)
          SELECT value,row_number() OVER(ORDER BY count DESC,"Ordinal",position) AS ordinal FROM counted WHERE first=1`);
        change(field, values, ItemUpdateType.MetadataEdit, (previous = [], next) => sequenceEqual(previous, next));
      }
      item.ProviderIds ??= {};
      for (const provider of ['MusicBrainzAlbumArtist', 'MusicBrainzAlbum', 'MusicBrainzReleaseGroup']) {
        const selected = (await session.client.query(`SELECT ${q(provider)} AS value,count(*) AS count,min("Ordinal") AS first FROM ${source}
          GROUP BY ${q(provider)} ORDER BY count DESC,first LIMIT 1`)).rows[0];
        const first = selected ? decode(selected.value) : undefined;
        const existingKey = Object.keys(item.ProviderIds).find(value => ordinalIgnoreCaseEquals(value, provider)) ?? provider;
        if (first != null && first !== '' && !ordinalIgnoreCaseEquals(item.ProviderIds[existingKey], first)) {
          if (!clrTrim(first)) throw new TypeError("The value cannot be an empty string or composed entirely of whitespace. (Parameter 'value')");
          trySetProviderId(item, existingKey, first); updateType |= ItemUpdateType.MetadataEdit;
        }
      }
    }
  });
  if (item.Type === 'Season' && full) change('IsVirtualItem', item.LocationType === 'Virtual' && allVirtual, ItemUpdateType.MetadataEdit);
  return updateType;
}
