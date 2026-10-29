import { readFile } from 'node:fs/promises';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';

const root = new URL('./fixtures/item-deletion/', import.meta.url);
export const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
export async function recordCurrentItemDeletionOnce() {
  return recordCurrentOracleOnce({ owner: import.meta.url,
    label: 'item-deletion', project: 'tests/http/fixtures/item-deletion/Oracle.csproj',
    input: 'tests/http/fixtures/item-deletion/input.json' });
}
