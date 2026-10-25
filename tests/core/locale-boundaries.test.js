import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Localization } from '../../src/core/i18n.js';

test('request culture cookie and quality boundaries match ASP.NET runtime recordings', async () => {
  const cases = JSON.parse(await readFile(new URL('../fixtures/core/locale-boundaries-oracle.json', import.meta.url), 'utf8'));
  for (const row of cases) {
    const actual = new Localization().negotiate({ url: `/${row.input.query ?? ''}`, headers: {
      ...(row.input.header ? { 'accept-language': row.input.header } : {}),
      ...(row.input.cookie ? { cookie: row.input.cookie } : {}),
    } });
    assert.deepEqual(actual, { culture: row.culture, uiCulture: row.uiCulture }, JSON.stringify(row.input));
  }
});
