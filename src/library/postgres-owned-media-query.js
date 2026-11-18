import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage, visitPostgresItemPlanPages } from '../database/postgres-item-query.js';
import { nativeItemDescriptor, nativeItemTypes } from './native-item-entity.js';
import { resolvePostgresSearchCollation } from './postgres-search-provider.js';
import { idKey, VIDEO_TYPES } from './records.js';

const videoTypes = () => nativeItemTypes.filter(type => nativeItemDescriptor(type).family === 'video');
const table = database => `${q(database.schemaName)}.${q('BaseItems')}`;
const displayExtraTypes = [0, 1, 3, 4, 5, 6, 7, 10, 11];
export const ownedExtraCountKey = owner => JSON.stringify([idKey(owner.Id), owner.NativeType,
  owner.PrimaryVersionId == null ? null : idKey(owner.PrimaryVersionId)]);

/** Cast each declared identity to Video and apply IsVisible, without its standalone parent checks. */
export function queryPostgresVideoParts(database, ids, { userId, visibility, configuration } = {}) {
  return queryPostgresItemPage(database, { ids, includeitemtypes: [...VIDEO_TYPES] }, {
    scope: { ids }, userId, includeOwnedItems: true, includeAlternateVersions: true,
    resumableMode: 'memory', memorySortConfiguration: configuration,
    memoryRatingContext: visibility?.ratingContext,
    visibility: userId ? { ...visibility, itemMode: 'standalone', scopeTopParentAccess: false } : undefined,
  });
}

/** Restore path occurrences after SQL selection; culture-equal keys retain their declaration order. */
export async function orderPostgresVideoPartOccurrences(database, ids, parts, { culture = 'en-US' } = {}) {
  let collation, failed = false, failure;
  try {
    collation = await resolvePostgresSearchCollation(database, culture);
    const sql = nativeTextSql(database.schemaName);
    const key = `replace(replace(${sql.projection('"SortName"')}, chr(1) || '0', ''), chr(1) || '1', '')`;
    const result = await database.client.query({ text: `WITH selected AS (
      SELECT part."Id", part."SortName", source.ordinal
      FROM unnest($1::text[]) WITH ORDINALITY source("Id", ordinal)
      JOIN unnest($2::text[], $3::bytea[]) part("Id", "SortName") ON part."Id" = source."Id"
    ), ordered AS (
      SELECT "Id", row_number() OVER (ORDER BY ${key}
        COLLATE ${q(collation.schema)}.${q(collation.name)} ASC NULLS FIRST, ordinal) AS ordinal
      FROM selected
    ), total AS (SELECT count(*)::bigint AS count FROM selected)
    SELECT ordered."Id", total.count FROM total LEFT JOIN ordered ON TRUE ORDER BY ordered.ordinal NULLS LAST`,
    values: [ids.map(idKey), parts.map(part => idKey(part.Id)),
      parts.map(part => part.SortName == null ? null : nativeTextBytes(part.SortName))] });
    const total = Number(result.rows[0].count);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid additional-part count.');
    return { ids: result.rows.filter(row => row.Id !== null).map(row => row.Id), total };
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await collation?.release(failed ? failure : undefined); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], failure?.message ?? 'Additional-part selection and collation release failed.', { cause: failure });
      throw error;
    }
  }
}

function extraMemberships(database, source, types) {
  const sql = nativeTextSql(database.schemaName), items = table(database);
  const links = `${q(database.schemaName)}.${q('LinkedChildren')}`;
  const same = (left, right) => `${sql.guidKey(left)} = ${sql.guidKey(right)}`;
  return `source AS (
      ${source}
    ), primary_versions AS (
      SELECT source.owner_id, primary_item."Id", primary_item."Type" FROM source
      JOIN ${items} primary_item ON ${same('primary_item."Id"', 'source."PrimaryVersionId"')}
      WHERE source."Type" = ANY(${types}) AND primary_item."Type" = ANY(${types})
    ), grouped AS (
      SELECT owner_id, "Id", "Type" FROM source
      UNION SELECT source.owner_id, child."Id", child."Type" FROM source
      JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE source."Type" = ANY(${types}) AND link."ChildType" = 3 AND child."Type" = ANY(${types})
      UNION SELECT owner_id, "Id", "Type" FROM primary_versions
      UNION SELECT source.owner_id, child."Id", child."Type" FROM primary_versions source
      JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE link."ChildType" = 3 AND child."Type" = ANY(${types})
    ), versions AS (
      SELECT owner_id, "Id" FROM grouped
      UNION SELECT source.owner_id, child."Id" FROM grouped source
      JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE source."Type" = ANY(${types}) AND link."ChildType" = 2
    ), owned_extra_memberships AS (
      SELECT owner.owner_id, extra."Id", extra."ExtraType" FROM ${items} extra
      JOIN versions owner ON ${same('owner."Id"', 'extra."OwnerId"')}
    )`;
}

/** BaseItem.GetExtras/Video.GetExtraOwnerIds: repository selection over the complete actual version family. */
export function visitPostgresOwnedExtras(database, ownerId, { userId, visibility, kind, seriesKey }, visit) {
  const sql = nativeTextSql(database.schemaName);
  const { topParentIds: _topParents, ...extraVisibility } = visibility;
  const values = [idKey(ownerId), videoTypes().map(nativeTextBytes)];
  const seriesScope = seriesKey
    ? ` OR ("Type" = $3::bytea AND "PresentationUniqueKey" = $4::bytea)`
    : '';
  if (seriesKey) values.push(nativeTextBytes('MediaBrowser.Controller.Entities.TV.Series'), nativeTextBytes(seriesKey));
  const source = `SELECT "Id" AS owner_id, "Id", "Type", "PrimaryVersionId" FROM ${table(database)}
    WHERE ${sql.guidKey('"Id"')} = $1::text${seriesScope}`;
  const ownerPlan = `WITH ${extraMemberships(database, source, '$2::bytea[]')}
    SELECT "Id" FROM owned_extra_memberships${kind === 'trailers' ? ' WHERE "ExtraType" = 2' : ''}`;
  const options = {
    userId, visibility: extraVisibility, includeOwnedItems: true,
    groupByPresentationKey: Boolean(userId), includeOrdinal: true,
    itemIdsPlan: { text: ownerPlan, values },
  };
  const plan = buildPostgresItemPageQuery(database, { sortby: ['sortname'], sortorder: ['ascending'] }, options);
  if (kind === 'trailers') return visitPostgresItemPlanPages(database, plan, options, visit);
  // The native controller keeps the display types after the repository has
  // selected and grouped all of the owner's extras.
  return visitPostgresItemPlanPages(database, {
    ...plan, values: [...plan.values, displayExtraTypes],
    text: `SELECT selected."Id", selected."TotalRecordCount"
      FROM (${plan.text}) selected JOIN ${table(database)} extra ON extra."Id" = selected."Id"
      WHERE extra."ExtraType" = ANY($${plan.values.length + 1}::int[]) ORDER BY selected."__ordinal"`,
  }, options, visit);
}

/** DTO counts use GetExtras without a user; selected owners share one bounded SQL version frame. */
export async function queryPostgresOwnedExtraCounts(database, owners) {
  const selected = owners.map(item => ({ Id: item.Id, NativeType: item.NativeType, PrimaryVersionId: item.PrimaryVersionId ?? null }));
  const sql = nativeTextSql(database.schemaName);
  const source = `SELECT requested.ordinal AS owner_id, requested."Id", requested."Type", requested."PrimaryVersionId"
    FROM unnest($1::bytea[], $2::bytea[], $3::bytea[]) WITH ORDINALITY requested("Id", "Type", "PrimaryVersionId", ordinal)`;
  const eligible = buildPostgresItemPageQuery(database, {}, { includeOwnedItems: true,
    itemIdsPlan: { text: 'SELECT "Id" FROM owned_extra_memberships', values: [] } });
  const eligibleText = eligible.text.replace(/\$(\d+)\b/gu, (_match, index) => '$' + (Number(index) + 4));
  const result = await database.client.query({ text: `WITH ${extraMemberships(database, source, '$4::bytea[]')},
    eligible AS (${eligibleText})
    SELECT source.owner_id AS "Ordinal",
      count(*) FILTER (WHERE eligible."Id" IS NOT NULL AND member."ExtraType" = 2) AS trailers,
      count(*) FILTER (WHERE eligible."Id" IS NOT NULL AND member."ExtraType" IN (${displayExtraTypes.join(',')})) AS features
    FROM source LEFT JOIN owned_extra_memberships member ON member.owner_id = source.owner_id
    LEFT JOIN eligible ON ${sql.guidKey('eligible."Id"')} = ${sql.guidKey('member."Id"')}
    GROUP BY source.owner_id`, values: [selected.map(item => nativeTextBytes(item.Id)),
      selected.map(item => nativeTextBytes(item.NativeType)), selected.map(item => item.PrimaryVersionId == null ? null : nativeTextBytes(item.PrimaryVersionId)),
      videoTypes().map(nativeTextBytes), ...eligible.values] });
  return new Map(result.rows.map(row => {
    const trailers = Number(row.trailers), features = Number(row.features);
    if (![trailers, features].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('PostgreSQL returned an invalid owned-extra count.');
    }
    return [ownedExtraCountKey(selected[Number(row.Ordinal) - 1]), { LocalTrailerCount: trailers, SpecialFeatureCount: features }];
  }));
}
