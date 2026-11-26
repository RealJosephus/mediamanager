import { lowerInvariant } from '../core/identity.js';
import { quoteIdentifier as q } from '../database/model.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery, visitPostgresRowPlanPages } from '../database/postgres-item-query.js';
import { clrTrim } from '../metadata/whitespace.js';
import { idKey, nonemptyId } from './records.js';

const personType = nativeTextBytes('MediaBrowser.Controller.Entities.Person');
const validType = name => name.length > 0 && name.split('').every(character => /^[\p{L}\p{N}]$/u.test(character));
// CLR casing uses a simple mapping. Locale-specific full-string expansions
// such as sharp S into SS do not appear in the SQLite query parameter.
const upper = (text, culture) => Array.from(text, character => {
  const mapped = character.toLocaleUpperCase(culture);
  return [...mapped].length === 1 ? mapped : character;
}).join('');

/** Page the repository's credited names that have a by-name Person entity. */
export function visitPostgresPeople(database, input, { userId, visibility, culture, signal }, visit) {
  const sql = nativeTextSql(database.schemaName);
  const table = name => `${q(database.schemaName)}.${q(name)}`;
  const ctes = [], predicates = [], values = [];
  const bind = value => { values.push(value); return '$' + values.length; };
  const same = (left, right) => `${sql.guidKey(left)} = ${sql.guidKey(right)}`;
  const related = `${table('PeopleBaseItemMap')} relation`;
  const credit = same('relation."PeopleId"', 'person."Id"');
  if (visibility) {
    const { topParentIds, ...access } = visibility;
    const accessible = buildPostgresItemPageQuery(database, {}, {
      userId, scope: { topParentIds }, visibility: access,
      includeOwnedItems: true, includeAlternateVersions: true, includePlaceholderRows: true,
    });
    ctes.push(`accessible AS (${accessible.text})`);
    values.push(...accessible.values);
    predicates.push(`EXISTS (SELECT 1 FROM ${related} JOIN accessible ON ${same('accessible."Id"', 'relation."ItemId"')} WHERE ${credit})`);
  }
  const namedPerson = `named."Type" = ${bind(personType)} AND named."Name" = person."Name"`;
  if (userId && input.isFavorite !== undefined) {
    predicates.push(`EXISTS (SELECT 1 FROM ${table('BaseItems')} named
      JOIN ${table('UserData')} data ON ${same('data."ItemId"', 'named."Id"')}
      WHERE ${namedPerson}
        AND ${sql.guidKey('data."UserId"')} = ${bind(idKey(userId))} AND data."IsFavorite" = ${bind(input.isFavorite)})`);
  } else {
    predicates.push(`EXISTS (SELECT 1 FROM ${table('BaseItems')} named WHERE ${namedPerson})`);
  }
  if (input.parentId !== undefined) predicates.push(`EXISTS (SELECT 1 FROM ${related}
    JOIN ${table('AncestorIds')} ancestor ON ${same('ancestor."ItemId"', 'relation."ItemId"')}
    WHERE ${credit} AND ${sql.guidKey('ancestor."ParentItemId"')} = ${bind(idKey(input.parentId))})`);
  if (nonemptyId(input.appearsInItemId)) predicates.push(`EXISTS (SELECT 1 FROM ${related}
    WHERE ${credit} AND ${sql.guidKey('relation."ItemId"')} = ${bind(idKey(input.appearsInItemId))})`);
  const includedTypes = input.personTypes.filter(validType).map(nativeTextBytes);
  const excludedTypes = input.excludePersonTypes.filter(validType).map(nativeTextBytes);
  if (includedTypes.length) predicates.push(`person."PersonType" = ANY(${bind(includedTypes)}::bytea[])`);
  if (excludedTypes.length) predicates.push(`(person."PersonType" IS NULL OR NOT person."PersonType" = ANY(${bind(excludedTypes)}::bytea[]))`);
  if (clrTrim(input.searchTerm ?? '')) {
    const upperName = sql.fromProjection(`translate(${sql.projection('person."Name"')},
      'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`);
    predicates.push(`position(${bind(nativeTextBytes(upper(input.searchTerm, culture)))}::bytea in ${upperName}) > 0`);
  }
  if (clrTrim(input.nameStartsWith ?? '')) {
    const prefix = lowerInvariant(input.nameStartsWith).replace(/[\\%_]/gu, '\\$&');
    predicates.push(sql.sqliteLike('person."Name"', bind(nativeTextBytes(prefix + '%')), `E'\\\\'`));
  }
  if (clrTrim(input.nameLessThan ?? '')) predicates.push(`person."Name" < ${bind(nativeTextBytes(lowerInvariant(input.nameLessThan)))}`);
  if (clrTrim(input.nameStartsWithOrGreater ?? '')) predicates.push(`person."Name" >= ${bind(nativeTextBytes(lowerInvariant(input.nameStartsWithOrGreater)))}`);
  const key = sql.sqliteAsciiLowerKey('person."Name"');
  const startIndex = input.startIndex ?? 0;
  const limit = input.limit > 0 ? input.limit : undefined;
  ctes.push(`names AS (SELECT DISTINCT ON (${key}) person."Name", ${key} AS "OrderName"
    FROM ${table('Peoples')} person ${predicates.length ? 'WHERE ' + predicates.join(' AND ') : ''}
    ORDER BY ${key}, person."Id")`,
  `page AS (SELECT * FROM names ORDER BY "OrderName" ${limit === undefined ? '' : 'LIMIT ' + bind(limit)}
    OFFSET ${bind(Math.max(startIndex, 0))})`,
  'total AS (SELECT count(*) AS "TotalRecordCount" FROM names)');
  return visitPostgresRowPlanPages(database, {
    text: `WITH ${ctes.join(',\n')}
      SELECT page."Name", total."TotalRecordCount" FROM total LEFT JOIN page ON TRUE ORDER BY page."OrderName"`,
    values, limit, startIndex,
  }, { signal }, rows => visit(rows.filter(row => row.Name != null).map(row => decodeNativeTextBytes(row.Name))));
}
