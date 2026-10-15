import { dependencyOrder } from '../../src/database/model.js';

const idKey = value => String(value ?? '').replaceAll('-', '').toLowerCase();
const emptyId = value => !value || /^0+$/u.test(idKey(value));

async function seedBaseItems(database, rows) {
  const remaining = [...rows];
  const seedIds = new Set(remaining.map(row => idKey(row.Id)));
  const inserted = new Set();
  while (remaining.length) {
    let progressed = false;
    for (let index = 0; index < remaining.length;) {
      const row = remaining[index];
      const rowId = idKey(row.Id);
      const ready = [row.ParentId, row.OwnerId].every(reference => {
        const key = idKey(reference);
        return emptyId(reference) || key === rowId || !seedIds.has(key) || inserted.has(key);
      });
      if (!ready) { index++; continue; }
      await database.insert('BaseItems', row);
      inserted.add(rowId);
      remaining.splice(index, 1);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(`BaseItems seed contains a ParentId/OwnerId cycle: ${remaining.map(row => row.Id).join(', ')}`);
    }
  }
}

export async function seedPostgresRuntime(database, seed) {
  for (const table of dependencyOrder()) {
    const rows = seed[table.name] ?? [];
    if (table.name === 'BaseItems') await seedBaseItems(database, rows);
    else for (const row of rows) await database.insert(table.name, row);
  }
  await database.resetSequences();
}
