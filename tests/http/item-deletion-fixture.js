import { readFile } from 'node:fs/promises';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';
import { normalizeDeletionRecording } from './fixtures/item-deletion/normalize.js';

const root = new URL('./fixtures/item-deletion/', import.meta.url);
export const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
export async function recordCurrentItemDeletionOnce() {
  const record = await recordCurrentOracleOnce({ owner: import.meta.url,
    label: 'item-deletion', project: 'tests/http/fixtures/item-deletion/Oracle.csproj',
    input: 'tests/http/fixtures/item-deletion/input.json' });
  return { ...record, native: normalizeDeletionRecording(record.native) };
}
