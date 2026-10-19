import test from 'node:test';
import assert from 'node:assert/strict';
import cases from './fixtures/ordinal-comparer.json' with { type: 'json' };
import { ordinalIgnoreCaseEquals } from '../../src/storage/ordinal-comparer.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';

test('ordinal identity comparison matches CLR Unicode and whole-string cases', () => {
  for (const sample of cases) assert.equal(ordinalIgnoreCaseEquals(sample.left, sample.right), sample.equal, JSON.stringify(sample));
  const mappings = new IdentityAccessMap();
  mappings.addPrefix({ identityRoot: '/Σ/I', accessRoot: '/network', caseSensitive: false, returnAccess: 'isolated fixture' });
  assert.equal(mappings.resolve({ identityPath: '/ς/i/原始.mkv' }), '/network/原始.mkv');
  assert.throws(() => mappings.resolve({ identityPath: '/ς/ı/media.mkv' }), { code: 'not-found' });
  assert.equal(mappings.identityFor('/network/原始.mkv').identityPath, '/Σ/I/原始.mkv');
});
