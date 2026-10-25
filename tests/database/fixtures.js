import { nativeModel, dependencyOrder } from '../../src/database/model.js';

export const fixtureIds = Object.fromEntries(nativeModel.tables.map((table, index) => [table.name, `12345678-1234-1234-1234-${String(index + 1).padStart(12, '0')}`]));
export function fixtureRow(table) {
  const values = {};
  for (const column of table.columns) {
    const type = column.clrType.replace('?', '');
    let value;
    if (type === 'Guid') value = fixtureIds[table.name];
    else if (type === 'DateTime') value = '2026-09-26 13:45:22.1234567';
    else if (column.type === 'BLOB') value = Buffer.from([0, 255, 1, 128]);
    else if (column.type === 'TEXT') value = `${column.name}: 中文 / café / %2e #`;
    else if (column.type === 'REAL') value = 1.23456789012345;
    else if (type === 'bool') value = true;
    else if (type === 'long') value = 9223372036854775000n;
    else if (type === 'uint') value = 4294967295n;
    else value = 1;
    if (column.name === 'Data') value = '{ "unknown-provider" : ["中文", 9223372036854775807], "key" : null }';
    if (column.name === 'KeyframeTicks') value = '[0,9223372036854775000]';
    if (column.name === 'Path') value = 'Z:\\媒体\\100% #.mkv';
    if (table.name === 'BaseItems' && ['OwnerId', 'ParentId'].includes(column.name)) value = null;
    values[column.name] = value;
  }
  for (const fk of table.foreignKeys) {
    if (fk.table === table.name) continue;
    for (let index = 0; index < fk.columns.length; index++) {
      const target = nativeModel.tables.find((entry) => entry.name === fk.table);
      const targetColumn = target.columns.find((entry) => entry.name === fk.referencedColumns[index]);
      values[fk.columns[index]] = targetColumn.type === 'INTEGER' ? 1 : fixtureIds[fk.table];
    }
  }
  return values;
}
export function seedAllTables(database) {
  database.transaction(() => {
    for (const table of dependencyOrder()) database.insert(table.name, fixtureRow(table));
    const linked = fixtureRow(nativeModel.tables.find((table) => table.name === 'LinkedChildren'));
    database.insert('LinkedChildren', { ...linked, SortOrder: 2 });
    const userData = fixtureRow(nativeModel.tables.find((table) => table.name === 'UserData'));
    database.insert('UserData', { ...userData, CustomDataKey: '', Likes: null, LastPlayedDate: null });
    const log = fixtureRow(nativeModel.tables.find((table) => table.name === 'ActivityLogs'));
    database.insert('ActivityLogs', { ...log, Id: 200 });
    database.delete('ActivityLogs', { Id: 200 });
  });
}
