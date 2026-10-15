import test from 'node:test';
import assert from 'node:assert/strict';
import { getRatingScore, loadLocalizationData } from '../../src/core/localization-data.js';

// Recorded from the frozen Emby.Server.Implementations.dll after LoadAll. The
// set covers native resource lookup, case folding, numeric parsing, prefixes,
// unrated markers, slash-containing systems and multi-rating fallbacks.
const oracle = [
  ['CA-R', 'CA', { score: 18, subScore: 1 }],
  ['FSK-16', 'DE', { score: 16, subScore: null }],
  ['FSK-18', 'US', { score: 18, subScore: null }],
  ['TV-MA', 'US', { score: 17, subScore: 1 }],
  ['XXX', 'asdf', { score: 1000, subScore: null }],
  ['Germany: FSK-18', 'DE', { score: 18, subScore: null }],
  ['Rated : R', 'US', { score: 17, subScore: 0 }],
  ['Rated: R', 'US', { score: 17, subScore: 0 }],
  ['Rated R', 'US', { score: 17, subScore: 0 }],
  [' PG-13 ', 'US', { score: 13, subScore: 0 }],
  ['T', 'IT', { score: 0, subScore: null }],
  ['VM6', 'IT', { score: 6, subScore: null }],
  ['VM 18', 'IT', { score: 18, subScore: null }],
  ['IT-VM14', 'US', { score: 14, subScore: null }],
  ['Vietato ai minori di 18 anni', 'IT', { score: 18, subScore: null }],
  ['btl', 'se', { score: 0, subScore: null }],
  ['BARNTILLÅTEN', 'se', { score: 0, subScore: null }],
  ['SE-BTL', 'us', { score: 0, subScore: null }],
  ['Från 7 År', 'se', { score: 7, subScore: null }],
  ['SE-Från 7 År', 'us', { score: 7, subScore: null }],
  ['0', 'NL', { score: 0, subScore: null }],
  ['+18', 'NL', { score: 18, subScore: null }],
  ['18+', 'NL', { score: 18, subScore: null }],
  ['-1', 'NL', { score: -1, subScore: null }],
  ['2147483647', 'NL', { score: 2147483647, subScore: null }],
  ['2147483648', 'NL', null],
  ['NR', 'US', null],
  ['unrated', 'US', null],
  ['Not Rated', 'US', null],
  ['n/a', 'US', null],
  ['UR', 'US', { score: 18, subScore: null }],
  ['NR / R', 'US', { score: 17, subScore: 0 }],
  ['unrated / R', 'US', { score: 17, subScore: 0 }],
  ['R / NR', 'US', { score: 17, subScore: 0 }],
  ['M/3', 'pt', { score: 3, subScore: null }],
  ['M/12', 'us', { score: 12, subScore: null }],
  ['U/A 13+', 'in', { score: 13, subScore: null }],
  ['7/i/fig', 'es', { score: 11, subScore: null }],
  ['18/fig', 'es', { score: 18, subScore: null }],
  ['-NO RATING SHOWN-', 'US', null],
  [':NO RATING SHOWN:', 'US', null],
  ['TV-MA', 'DE', { score: 17, subScore: 1 }],
  ['PG-13', 'FR', { score: 13, subScore: 0 }],
  ['R', 'JP', { score: 17, subScore: 0 }],
  ['US:INVALID', 'US', null],
  ['DE-INVALID', 'US', null],
  ['us:R', 'DE', { score: 17, subScore: 0 }],
  ['US:PG-13', 'DE', { score: 13, subScore: 0 }],
  ['ca:R', 'US', { score: 18, subScore: 1 }],
  ['DE-18+', 'US', { score: 18, subScore: null }],
  ['German:FSK-18', 'US', { score: 18, subScore: null }],
  ['NR / U/A 13+ / R', 'US', { score: 0, subScore: null }],
  ['Rated Rated R', 'US', { score: 17, subScore: 0 }],
  ['18+ ', 'US', { score: 18, subScore: 1 }],
  [' 18+', 'US', { score: 18, subScore: null }],
];

test('parental rating resolution matches the actual frozen Jellyfin DLL oracle', () => {
  for (const [rating, country, expected] of oracle) assert.deepEqual(getRatingScore(rating, country, country), expected, `${country}: ${rating}`);
  assert.throws(() => getRatingScore('', 'US'), /empty/i);
});

test('localization data exposes native country rating lists without changing score resolution', () => {
  const data = loadLocalizationData();
  assert.equal(data.parentalRatings('US').length, 56);
  assert.equal(data.parentalRatings('DE').length, 24);
  assert.deepEqual(data.ratingScore('TV-Y7-FV', 'US'), { score: 7, subScore: 1 });
  assert.equal(data.countries.length, 140);
  assert.equal(data.cultures().length, 494);
});
