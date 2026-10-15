import assert from 'node:assert/strict';
import test from 'node:test';
import { hasFilters, parseQuery, resolveOfficialRatingRanges } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';

test('official-rating range strings use first-value scalar binding and the configured rating system', () => {
  const repeated = new URLSearchParams();
  repeated.append('MinOfficialRating', 'TV-14-D');
  repeated.append('MinOfficialRating', 'R');
  repeated.append('MaxOfficialRating', '14');
  assert.deepEqual(parseQuery(repeated), {
    minofficialrating: 'TV-14-D',
    maxofficialrating: '14',
  });
  assert.deepEqual(resolveOfficialRatingRanges(parseQuery(repeated), { MetadataCountryCode: 'US' }), {
    minparentalrating: { score: 14, subScore: 1 },
    maxparentalrating: { score: 14, subScore: null },
  });
  assert.deepEqual(resolveOfficialRatingRanges(parseQuery({ MinOfficialRating: 'INVALID' })), {});
  assert.deepEqual(parseQuery({ MaxOfficialRating: ' ' }), {});
  assert.equal(hasFilters({ minparentalrating: { score: 13, subScore: 0 } }), true);
  assert.equal(hasFilters({ maxparentalrating: { score: 13, subScore: 0 } }), false,
    'InternalItemsQuery.IsEmpty includes the minimum but not the maximum parental rating');
});
