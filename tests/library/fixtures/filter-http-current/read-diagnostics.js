import { createHash } from 'node:crypto';

const retained = new WeakMap();
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const sha = value => createHash('sha256').update(value).digest('hex');
const timestamps = new Set(['DateLastActivity', 'LastActivityDate', 'LastLoginDate', 'DateCreated', 'DateModified', 'DateLastSaved', 'LastUpdated']);
const isoTimestamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/u;
const limits = Object.freeze({ rows: 64, cells: 256 });

/** Keep already-read canonical rows private; diagnostics do not enter the
 * complete database equality value or require an additional SQLite read. */
export function retainReadDiagnosticRows(snapshot, tables) {
  retained.set(snapshot, new Map(tables.map(table => [table.name, table])));
  return snapshot;
}

function cell(value, name, present) {
  if (!present) return { kind: 'absent' };
  if (value === null) return { kind: 'null' };
  const blob = value?.type === 'blob', kind = blob ? 'blob' : value?.type === 'bigint' ? 'bigint' : typeof value;
  const bytes = blob ? Buffer.from(value.base64, 'base64') : Buffer.from(stable(value));
  return { kind, bytes: bytes.length, sha256: sha(bytes),
    ...(typeof value === 'string' && timestamps.has(name) && isoTimestamp.test(value) ? { value } : {}) };
}

function rowsByKey(table) {
  const counts = new Map();
  return new Map((table?.rows ?? []).map(row => {
    const value = stable(table.primaryKey.length ? table.primaryKey.map(name => row[name]) : row);
    const ordinal = counts.get(value) ?? 0; counts.set(value, ordinal + 1);
    return [value + ':' + ordinal, { row, keySha256: sha(value), rowSha256: sha(stable(row)) }];
  }));
}

/** Complete per-table SHA/count observations plus bounded cell fingerprints.
 * Only explicitly named SQL timestamp columns may expose their timestamp;
 * credentials, arbitrary TEXT/Data, blobs and primary keys remain hash-only. */
export function describeReadDifference(before, after) {
  const prior = new Map(before.tableSummaries.map(table => [table.name, table]));
  const next = new Map(after.tableSummaries.map(table => [table.name, table]));
  const beforeRows = retained.get(before), afterRows = retained.get(after);
  const tables = [], changes = []; let retainedRows = 0, retainedCells = 0, truncated = false;
  for (const name of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
    const left = prior.get(name), right = next.get(name), equal = stable(left) === stable(right);
    const metadata = value => value == null ? null : sha(stable(Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['rowCount', 'rowsSha256'].includes(key)))));
    tables.push({ name, beforeCount: left?.rowCount ?? null, afterCount: right?.rowCount ?? null,
      beforeSha256: left?.rowsSha256 ?? null, afterSha256: right?.rowsSha256 ?? null,
      beforeSchemaSha256: metadata(left), afterSchemaSha256: metadata(right), stable: equal });
    if (equal) continue;
    const oldRows = rowsByKey(beforeRows?.get(name)), newRows = rowsByKey(afterRows?.get(name)), rows = [];
    let changedRows = 0;
    for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const previous = oldRows.get(key), current = newRows.get(key);
      if (previous?.rowSha256 === current?.rowSha256) continue;
      changedRows++;
      if (retainedRows >= limits.rows) { truncated = true; continue; }
      retainedRows++;
      const cells = []; let changedCells = 0;
      for (const column of new Set([...Object.keys(previous?.row ?? {}), ...Object.keys(current?.row ?? {})])) {
        const oldValue = previous?.row[column], newValue = current?.row[column];
        const oldPresent = previous != null && Object.hasOwn(previous.row, column), newPresent = current != null && Object.hasOwn(current.row, column);
        if (oldPresent === newPresent && stable(oldValue) === stable(newValue)) continue;
        changedCells++;
        if (retainedCells >= limits.cells) { truncated = true; continue; }
        retainedCells++;
        cells.push({ column, before: cell(oldValue, column, oldPresent), after: cell(newValue, column, newPresent) });
      }
      rows.push({ keySha256: (previous ?? current).keySha256, beforeSha256: previous?.rowSha256 ?? null,
        afterSha256: current?.rowSha256 ?? null, changedCells, cells });
    }
    changes.push({ name, changedRows, retainedRows: rows.length, rows,
      rawOpaqueValuesPublished: false, privateRowsAvailable: beforeRows?.has(name) === true && afterRows?.has(name) === true });
  }
  return { tables, changes, limits, retainedRows, retainedCells, truncated,
    sequences: { beforeCount: before.sequences.length, afterCount: after.sequences.length,
      beforeSha256: before.sequencesSha256, afterSha256: after.sequencesSha256 },
    pragmas: { before: before.pragmas, after: after.pragmas },
    foreignKeyCheck: { before: before.foreignKeyCheck, after: after.foreignKeyCheck },
    integrityCheck: { before: before.integrityCheck, after: after.integrityCheck } };
}
