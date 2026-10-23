import { readFile } from 'node:fs/promises';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';

const root = new URL('./fixtures/parental-rating-unicode/', import.meta.url);

export const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));

export const recordCurrentParentalRatingOnce = () => recordCurrentOracleOnce({
  owner: import.meta.url,
  label: 'parental-rating-unicode',
  project: 'tests/core/fixtures/parental-rating-unicode/current/Oracle.csproj',
  input: 'tests/core/fixtures/parental-rating-unicode/input.json',
});
