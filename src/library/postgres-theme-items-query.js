import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { nativeItemDescriptor, nativeItemTypes } from './native-item-entity.js';
import { libraryError } from './records.js';

const rebase = (text, offset) => text.replace(/\$(\d+)/gu, (_, value) => `$${Number(value) + offset}`);

/** Select the nearest visible theme owner and its complete ordered result in SQL. */
export async function queryPostgresThemeItems(database, owner, {
  extraType, inheritFromParent = false, sortBy = [], sortOrder = [], userId, visibility,
  configuration = {}, ratingContext,
} = {}) {
  if (![8, 9].includes(extraType)) throw new TypeError('A theme song or theme video type is required.');
  if (sortBy.length && sortOrder.length > sortBy.length) {
    throw libraryError(400, 'Sort order count exceeds sort key count.');
  }
  const sql = nativeTextSql(database.schemaName);
  const items = `${q(database.schemaName)}.${q('BaseItems')}`;
  const links = `${q(database.schemaName)}.${q('LinkedChildren')}`;
  const same = (left, right) => `${sql.guidKey(left)} = ${sql.guidKey(right)}`;
  const videoTypes = nativeItemTypes.filter(type => nativeItemDescriptor(type).family === 'video');
  const folderTypes = nativeItemTypes.filter(type => nativeItemDescriptor(type).isFolder);
  const type = owner.NativeType ?? nativeItemTypes.find(type => nativeItemDescriptor(type).type === owner.Type);
  const nullableBytes = value => value == null ? null : nativeTextBytes(value);
  const values = [nativeTextBytes(owner.Id), nativeTextBytes(type), nullableBytes(owner.ParentId),
    nullableBytes(owner.PrimaryVersionId), inheritFromParent, extraType,
    folderTypes.map(type => nativeTextBytes(type)), videoTypes.map(type => nativeTextBytes(type))];
  const ctes = `theme_chain("Id", "Type", "ParentId", "PrimaryVersionId", depth, seen) AS (
      SELECT $1::bytea, $2::bytea, $3::bytea, $4::bytea, 0, ARRAY[${sql.guidKey('$1::bytea')}]
      UNION ALL
      SELECT parent."Id", parent."Type", parent."ParentId", parent."PrimaryVersionId",
        child.depth + 1, child.seen || ${sql.guidKey('parent."Id"')}
      FROM theme_chain child JOIN ${items} parent ON ${same('parent."Id"', 'child."ParentId"')}
      WHERE $5::boolean AND parent."Type" = ANY($7::bytea[])
        AND NOT (${sql.guidKey('parent."Id"')} = ANY(child.seen))
    ), theme_primaries AS (
      SELECT source."Id" AS owner_id, source.depth, primary_item."Id", primary_item."Type"
      FROM theme_chain source JOIN ${items} primary_item
        ON ${same('primary_item."Id"', 'source."PrimaryVersionId"')}
      WHERE source."Type" = ANY($8::bytea[]) AND primary_item."Type" = ANY($8::bytea[])
    ), theme_grouped AS (
      SELECT "Id" AS owner_id, depth, "Id", "Type" FROM theme_chain
      UNION
      SELECT source."Id", source.depth, child."Id", child."Type"
      FROM theme_chain source JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE source."Type" = ANY($8::bytea[]) AND link."ChildType" = 3 AND child."Type" = ANY($8::bytea[])
      UNION
      SELECT owner_id, depth, "Id", "Type" FROM theme_primaries
      UNION
      SELECT source.owner_id, source.depth, child."Id", child."Type"
      FROM theme_primaries source JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE link."ChildType" = 3 AND child."Type" = ANY($8::bytea[])
    ), theme_versions AS (
      SELECT owner_id, depth, "Id" FROM theme_grouped
      UNION
      SELECT source.owner_id, source.depth, child."Id"
      FROM theme_grouped source JOIN ${links} link ON ${same('link."ParentId"', 'source."Id"')}
      JOIN ${items} child ON ${same('child."Id"', 'link."ChildId"')}
      WHERE source."Type" = ANY($8::bytea[]) AND link."ChildType" = 2
    ), theme_memberships AS (
      SELECT DISTINCT owner.owner_id, owner.depth, extra."Id"
      FROM theme_versions owner JOIN ${items} extra ON ${same('extra."OwnerId"', 'owner."Id"')}
      WHERE extra."ExtraType" = $6::integer
    )`;
  // AddUserToQuery does not introduce a library scope for OwnerIds. The
  // user's repository rating and tag restrictions still select the extras.
  const { topParentIds: _topParents, ...extraVisibility } = visibility ?? {};
  const shared = { userId, visibility: userId ? extraVisibility : undefined, includeOwnedItems: true,
    includeOrdinal: true, memorySortConfiguration: configuration, memoryRatingContext: ratingContext };
  const eligible = buildPostgresItemPageQuery(database, {}, { ...shared,
    itemIdsPlan: { text: 'SELECT "Id" FROM theme_memberships', values: [] } });
  const eligibleText = rebase(eligible.text, values.length);
  values.push(...eligible.values);
  const selectedOwner = `theme_eligible AS (${eligibleText}), theme_selected_owner AS (
      SELECT owner."Id", owner.depth FROM theme_chain owner
      WHERE owner.depth = COALESCE(
        (SELECT min(member.depth) FROM theme_memberships member JOIN theme_eligible visible
          ON ${same('visible."Id"', 'member."Id"')}),
        (SELECT max(depth) FROM theme_chain))
    )`;
  const page = buildPostgresItemPageQuery(database, {
    sortby: sortBy.map(value => String(value).toLowerCase()),
    sortorder: sortOrder.map(value => String(value).toLowerCase()),
  }, { ...shared, visibility: undefined, resumableMode: 'memory', memorySourceOrder: 'stored-sort-name',
    // GetExtras already applied repository visibility. LibraryManager.Sort
    // only orders those results; it does not reapply in-memory tag/rating rules.
    itemIdsPlan: { text: `SELECT member."Id" FROM theme_memberships member
      JOIN theme_selected_owner owner ON ${same('owner."Id"', 'member.owner_id')}
      JOIN theme_eligible visible ON ${same('visible."Id"', 'member."Id"')}`, values: [] } });
  const pageText = rebase(page.text, values.length);
  values.push(...page.values);
  const result = await database.client.query({ text: `WITH RECURSIVE ${ctes}, ${selectedOwner},
      theme_ordered AS (${pageText})
    SELECT owner."Id" AS "OwnerId", selected."Id"
    FROM theme_selected_owner owner LEFT JOIN theme_ordered selected ON TRUE
    ORDER BY selected."__ordinal" NULLS LAST`, values });
  return {
    ownerId: result.rows[0] ? decodeNativeTextBytes(result.rows[0].OwnerId) : owner.Id,
    ids: result.rows.filter(row => row.Id != null).map(row => decodeNativeTextBytes(row.Id)),
  };
}
