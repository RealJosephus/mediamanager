import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { dateText } from '../library/records.js';
import { nativeGuid, wireGuid } from '../users/native.js';

export const activitySortFields = Object.freeze({ Name: 0, Overiew: 1, ShortOverview: 2, Type: 3,
  DateCreated: 5, Username: 6, LogSeverity: 7 });
export const activitySeverityNames = Object.freeze(['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical', 'None']);
const columns = ['Id', 'Name', 'Overview', 'ShortOverview', 'Type', 'ItemId', 'DateCreated', 'UserId', 'LogSeverity'];
const definition = tableDefinition('ActivityLogs');
const sortColumns = { 0: 'a."Name"', 1: 'a."Overview"', 2: 'a."ShortOverview"', 3: 'a."Type"',
  5: 'a."DateCreated"', 6: 'u."Username"', 7: 'a."LogSeverity"' };

// Microsoft.Data.Sqlite binds DateTime as TEXT with the seven-digit fraction
// trimmed. Compare the same stored bytes without a microsecond timestamp cast.
function sqliteDateParameter(value) {
  return value.slice(0, 19).replace('T', ' ') + (value.slice(20, 27).replace(/0+$/u, '')
    ? '.' + value.slice(20, 27).replace(/0+$/u, '') : '');
}

function rowDto(raw) {
  const row = Object.fromEntries(columns.map(name => [name, decodeValue(definition.columns.find(column => column.name === name), raw[name], 'postgres')]));
  return { Id: row.Id, Name: row.Name, Overview: row.Overview, ShortOverview: row.ShortOverview,
    Type: row.Type, ItemId: row.ItemId, Date: dateText(row.DateCreated), UserId: wireGuid(row.UserId),
    Severity: activitySeverityNames[row.LogSeverity] ?? row.LogSeverity };
}

/** ActivityManager's count and page run against the same tracked PG owner.
 * A consumer receives serial pages while the real cursor/session stays owned. */
export function queryActivityLog(store, input, { signal, consume } = {}) {
  // RequestHelpers.GetOrderBy fails before querying when a nonempty sortBy
  // list has more supplied directions than fields.
  if (input.sortBy.length && input.sortOrder.length > input.sortBy.length) {
    throw Object.assign(new Error('Too many activity sort directions.'), { status: 400 });
  }
  return store.run(async database => {
    const values = [], predicates = [], sql = nativeTextSql(database.schemaName);
    const bind = (value, type = 'bytea') => { values.push(value); return `$${values.length}::${type}`; };
    const text = value => bind(nativeTextBytes(value));
    if (input.hasUserId !== undefined) {
      predicates.push(`a."UserId" ${input.hasUserId ? '<>' : '='} ${text(nativeGuid('00000000000000000000000000000000'))}`);
    }
    if (input.minDate !== undefined) predicates.push(`a."DateCreated" >= ${text(sqliteDateParameter(input.minDate))}`);
    if (input.maxDate !== undefined) predicates.push(`a."DateCreated" <= ${text(sqliteDateParameter(input.maxDate))}`);
    for (const [name, column] of [['name', 'a."Name"'], ['overview', 'a."Overview"'],
      ['shortOverview', 'a."ShortOverview"'], ['type', 'a."Type"'], ['username', 'u."Username"']]) {
      if (input[name]) predicates.push(sql.sqliteLike(column, text('%' + input[name] + '%')));
    }
    if (input.itemId && input.itemId !== '00000000000000000000000000000000') predicates.push(`a."ItemId" = ${text(input.itemId)}`);
    if (input.severity !== undefined) predicates.push(`a."LogSeverity" = ${bind(input.severity, 'integer')}`);
    const from = `FROM ${q(database.schemaName)}."ActivityLogs" a LEFT JOIN ${q(database.schemaName)}."Users" u ON a."UserId" = u."Id"`;
    const where = predicates.length ? ' WHERE ' + predicates.join(' AND ') : '';
    const count = (await database.client.query(`SELECT COUNT(*)::integer AS count ${from}${where}`, values)).rows[0].count;
    let order = input.sortBy.length ? input.sortBy.map((field, index) => {
      const descending = (input.sortOrder[index] ?? input.sortOrder[0] ?? 0) !== 0;
      return `${sortColumns[field]} ${descending ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`;
    }).join(', ') : 'a."DateCreated" DESC';
    // Preserve SQLite's row-id tie order, including its reverse date index
    // traversal, without relying on PostgreSQL's physical tuple placement.
    const dateOnly = !input.sortBy.length || input.sortBy.length === 1 && input.sortBy[0] === 5;
    const reverseDate = !input.sortBy.length || (input.sortOrder[0] ?? 0) !== 0;
    order += `, a."Id" ${dateOnly && reverseDate ? 'DESC' : 'ASC'}`;
    // SQLite treats every negative LIMIT as unlimited, and negative OFFSET as
    // zero. StartIndex in the public DTO retains its original bound value.
    const limit = input.limit ?? 100;
    const paging = (limit < 0 ? '' : ` LIMIT ${bind(limit, 'integer')}`) + ` OFFSET ${bind(Math.max(input.startIndex ?? 0, 0), 'integer')}`;
    const select = `SELECT ${columns.map(column => `a.${q(column)}`).join(', ')} ${from}${where} ORDER BY ${order}${paging}`;
    const metadata = { TotalRecordCount: count, StartIndex: input.startIndex ?? 0 };
    if (!consume) {
      if (limit < 0 || limit > 128) throw new TypeError('Large activity responses require a streaming consumer.');
      return { Items: (await database.client.query(select, values)).rows.map(rowDto), ...metadata };
    }
    signal?.throwIfAborted();
    await database.client.query(`DECLARE activity_log_entries NO SCROLL CURSOR FOR ${select}`, values);
    let primary, failed = false;
    try {
      async function* pages() {
        for (;;) {
          signal?.throwIfAborted();
          const rows = (await database.client.query('FETCH FORWARD 128 FROM activity_log_entries')).rows;
          signal?.throwIfAborted();
          if (!rows.length) return;
          yield rows.map(rowDto);
        }
      }
      return await consume(metadata, pages());
    } catch (error) {
      failed = true; primary = error; throw error;
    } finally {
      try { await database.client.query('CLOSE activity_log_entries'); }
      catch (error) {
        database.discardConnection(error);
        if (failed) throw Object.assign(new AggregateError([primary, error], primary?.message ?? 'Activity query and cursor cleanup failed.', { cause: primary }),
          Object.fromEntries(['code', 'status', 'statusCode'].filter(key => primary?.[key] !== undefined).map(key => [key, primary[key]])));
        throw error;
      }
    }
  }, { signal, readOnly: Boolean(consume) });
}
