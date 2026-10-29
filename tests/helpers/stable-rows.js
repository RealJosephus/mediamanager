/** Preserve each fresh row while ordering by the existing snapshot text key. */
export function stableRows(rows) {
  const text = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  return rows.map(row => ({ row, key: text(row) }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en'))
    .map(entry => entry.row);
}
