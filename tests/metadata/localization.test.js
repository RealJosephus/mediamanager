import test from 'node:test';
import assert from 'node:assert/strict';
import { Localization } from '../../src/core/i18n.js';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { normalizeLanguage } from '../../plugins/tmdb/utils.js';

test('metadata language remains independent of request culture', async () => {
  const localization = new Localization();
  const results = await Promise.all(['en-US', 'zh-CN'].map((uiCulture) => localization.run({ uiCulture }, async () => {
    await Promise.resolve();
    return { language: parseNfo('<movie><language>es-419</language></movie>').Item.PreferredMetadataLanguage, tmdbLanguage: normalizeLanguage('es-419', 'AR') };
  })));
  assert.equal(results[0].language, results[1].language); assert.equal(results[1].tmdbLanguage, 'es-AR');
});
