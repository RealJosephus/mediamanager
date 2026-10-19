import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inputUrl = validationFileUrl('./fixtures/resolution-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/resolution-filters/native.json', import.meta.url);
const inputBytes = await readFile(inputUrl);
const input = JSON.parse(inputBytes);
const native = JSON.parse(await readFile(nativeUrl));
const cases = new Map(native.cases.map(entry => [entry.name, entry]));

test('frozen resolution-filter fixture is complete, internally linked, and input-hash pinned', () => {
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.frozenJellyfin, true);
  assert.equal(native.sourceEvidence, '.agent-docs/evidence/continuation-20260927/resolution-filter-native-v3/native-contract.json');
  assert.deepEqual(native.endpoints, ['/Items', '/Users/{userId}/Items']);
  assert.equal(native.fixtureInputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.cases.length, input.cases.length);
  assert.equal(cases.size, input.cases.length);
  const itemKeys = new Set(input.items.map(item => item.key));
  for (const entry of native.cases) {
    assert.ok(input.cases.some(candidate => candidate.name === entry.name
      && candidate.query === entry.query
      && JSON.stringify(candidate.scope) === JSON.stringify(entry.scope)
      && (candidate.auth ?? 'user') === entry.auth
      && JSON.stringify(candidate.endpoints ?? ['items', 'legacy']) === JSON.stringify(entry.endpoints)), entry.name);
    assert.ok(entry.scope.every(key => itemKeys.has(key)), entry.name);
    assert.ok(entry.keys.every(key => entry.scope.includes(key)), entry.name);
    assert.equal(entry.contentType, 'application/json; charset=utf-8', entry.name);
    if (entry.status === 200) {
      assert.ok(entry.totalRecordCount >= entry.keys.length, entry.name);
      assert.equal(entry.problem, null, entry.name);
    } else {
      assert.equal(entry.status, 400, entry.name);
      assert.equal(entry.totalRecordCount, null, entry.name);
      assert.equal(entry.problem.status, 400, entry.name);
      assert.equal(Object.hasOwn(entry.problem, 'traceId'), false, entry.name);
    }
  }
});

test('frozen resolution buckets use inclusive 1200/3800x2100 boundaries and union flags', () => {
  assert.deepEqual(cases.get('bucket-sd').keys, ['belowHd', 'sd']);
  assert.deepEqual(cases.get('bucket-hd').keys, ['fullHd', 'hdBoundary']);
  assert.deepEqual(cases.get('bucket-4k').keys, ['uhdHeightBoundary', 'uhdWidthBoundary']);
  assert.deepEqual(cases.get('is4k-false-alone').keys, []);
  assert.deepEqual(cases.get('bucket-hd-or-4k').keys, ['fullHd', 'hdBoundary', 'uhdHeightBoundary', 'uhdWidthBoundary']);
  assert.deepEqual(cases.get('bucket-sd-or-4k').keys, ['belowHd', 'sd', 'uhdHeightBoundary', 'uhdWidthBoundary']);
});

test('frozen dimension bounds are inclusive and intersect when combined', () => {
  assert.deepEqual(cases.get('min-width-inclusive').keys, ['fullHd', 'hdBoundary', 'uhdWidthBoundary']);
  assert.deepEqual(cases.get('max-width-inclusive').keys, ['belowHd', 'hdBoundary']);
  assert.deepEqual(cases.get('min-height-inclusive').keys, ['uhdHeightBoundary']);
  assert.deepEqual(cases.get('max-height-inclusive').keys, ['fullHd']);
  assert.deepEqual(cases.get('dimension-range-intersection').keys, ['fullHd', 'hdBoundary', 'uhdHeightBoundary']);
});

test('frozen filters classify the best alternate version while returning only the primary', () => {
  assert.deepEqual(cases.get('version-4k-bucket').keys, ['version4kPrimary']);
  assert.deepEqual(cases.get('version-4k-excluded-from-sd').keys, []);
  assert.deepEqual(cases.get('version-min-width').keys, ['version4kPrimary']);
  assert.deepEqual(cases.get('version-max-width').keys, []);
  assert.deepEqual(cases.get('version-min-height').keys, ['version4kPrimary']);
  assert.deepEqual(cases.get('version-max-height').keys, []);
  assert.deepEqual(cases.get('unprobed-primary-hd-by-version').keys, ['versionHdPrimary']);
  assert.deepEqual(cases.get('unprobed-primary-sd-by-version').keys, ['versionSdPrimary']);
  assert.deepEqual(cases.get('mixed-version-not-hd').keys, []);
  assert.deepEqual(cases.get('mixed-version-is-4k').keys, ['versionMixedPrimary']);
  assert.deepEqual(cases.get('tall-alternate-excludes-primary-from-sd').keys, []);
  assert.deepEqual(cases.get('tall-alternate-makes-primary-4k').keys, ['tall4kVersionPrimary']);
  assert.deepEqual(cases.get('split-alternates-satisfy-combined-minima').keys, ['versionSplitPrimary']);
});

test('frozen bucket filters descend through ordinary and direct-linked children, unlike numeric bounds', () => {
  assert.deepEqual(cases.get('ordinary-folder-descendant-4k').keys, ['descendantFolder']);
  assert.deepEqual(cases.get('ordinary-folder-dimension-does-not-descend').keys, []);
  assert.deepEqual(cases.get('direct-linked-media-child-4k').keys, ['linkedBoxSet']);
  assert.deepEqual(cases.get('direct-linked-dimension-does-not-descend').keys, []);
  assert.deepEqual(cases.get('linked-folder-matches-own-grandchild').keys, ['linkedGrandchildFolder']);
  assert.deepEqual(cases.get('linked-grandparent-does-not-traverse-folder').keys, []);
});

test('frozen 720x2160 media is simultaneously SD by width and 4K by height', () => {
  assert.deepEqual(cases.get('tall-self-is-sd-by-width').keys, ['tall4kSelf']);
  assert.deepEqual(cases.get('tall-self-is-also-4k-by-height').keys, ['tall4kSelf']);
});

test('frozen user grouping precedes count and paging while API-key queries remain ungrouped', () => {
  assert.deepEqual(cases.get('user-presentation-grouping').keys, ['groupFirst', 'groupThird']);
  assert.deepEqual(cases.get('user-grouping-before-count-and-pagination').keys, ['groupThird']);
  assert.equal(cases.get('user-grouping-before-count-and-pagination').totalRecordCount, 2);
  assert.deepEqual(cases.get('api-key-does-not-group-presentation-keys').keys,
    ['groupFirst', 'groupSecond', 'groupThird']);
  assert.deepEqual(cases.get('api-key-does-not-group-presentation-keys').endpoints, ['items']);
  assert.deepEqual(cases.get('bucket-filter-includes-owned-item').keys, ['owner4k']);
  assert.deepEqual(cases.get('numeric-filter-keeps-owned-item-hidden').keys, []);
});

test('frozen ASP.NET query binding preserves nullable, invalid, Int32, hex, and repeated-value edges', () => {
  assert.deepEqual(cases.get('binding-bool-case-insensitive').keys, ['hdBoundary']);
  assert.deepEqual(cases.get('binding-empty-nullable-bool').keys, ['hdBoundary', 'sd']);
  assert.deepEqual(cases.get('binding-empty-nullable-integer').keys, ['hdBoundary', 'sd']);
  assert.deepEqual(cases.get('binding-whitespace-nullable-integer').keys, ['hdBoundary', 'sd']);
  assert.equal(cases.get('binding-int32-max').status, 200);
  assert.deepEqual(cases.get('binding-int32-min').keys, ['hdBoundary', 'sd']);
  assert.deepEqual(cases.get('binding-hex-integer').keys, []);
  assert.deepEqual(cases.get('binding-hash-hex-integer').keys, []);
  assert.deepEqual(cases.get('binding-hex-int32-sign-bit').keys, ['sd']);
  assert.deepEqual(cases.get('binding-hex-uint32-max').keys, ['sd']);
  assert.deepEqual(cases.get('binding-repeated-integer').keys, ['hdBoundary', 'uhdWidthBoundary']);
  assert.deepEqual(cases.get('binding-repeated-bool-first-empty').keys, ['hdBoundary', 'sd']);
  assert.deepEqual(cases.get('binding-repeated-bool-first-valid').keys, ['sd']);
  assert.deepEqual(cases.get('binding-mixed-case-repeated-key').keys, ['sd']);
});

test('frozen validation problems use canonical parameter names and stable messages after trace removal', () => {
  const invalidBool = cases.get('binding-invalid-bool');
  assert.deepEqual(invalidBool.problem.errors, { isHd: ["The value '1' is not valid."] });
  const repeatedBool = cases.get('binding-repeated-bool-first-invalid');
  assert.deepEqual(repeatedBool.problem.errors, { isHd: ["The value '1,true' is not valid."] });
  for (const name of [
    'binding-invalid-integer',
    'binding-int32-overflow',
    'binding-floating-integer',
    'binding-negative-hex-integer',
    'binding-positive-hex-integer',
    'binding-hex-uint32-overflow',
    'binding-int32-negative-overflow'
  ]) {
    assert.deepEqual(Object.keys(cases.get(name).problem.errors), ['minWidth'], name);
    assert.match(cases.get(name).problem.errors.minWidth[0], /^The value '.+' is not valid\.$/u, name);
  }
});
