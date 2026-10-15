import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inputUrl = validationFileUrl('./fixtures/video-property-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/video-property-filters/native.json', import.meta.url);
const inputBytes = await readFile(inputUrl);
const input = JSON.parse(inputBytes);
const native = JSON.parse(await readFile(nativeUrl));
const cases = new Map(native.cases.map(entry => [entry.name, entry]));
const itemByKey = new Map(input.items.map(item => [item.key, item]));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

test('frozen video-property fixture is complete, endpoint-pinned, and linked to its exact input', () => {
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.frozenJellyfin, true);
  assert.equal(native.sourceEvidence, '.agent-docs/evidence/video-property-filters-native-v2/native-contract.json');
  assert.deepEqual(native.endpoints, ['/Items', '/Users/{userId}/Items']);
  assert.equal(native.fixtureInputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.cases.length, input.cases.length);
  assert.equal(cases.size, input.cases.length);
  for (const entry of native.cases) {
    const source = input.cases.find(candidate => candidate.name === entry.name);
    assert.ok(source, entry.name);
    assert.equal(entry.query, source.query, entry.name);
    assert.deepEqual(entry.scope, source.scope, entry.name);
    assert.equal(entry.auth, source.auth ?? 'user', entry.name);
    assert.deepEqual(entry.endpoints, source.endpoints ?? ['items', 'legacy'], entry.name);
    assert.ok(entry.keys.every(key => entry.scope.includes(key)), entry.name);
    assert.deepEqual(entry.ids, entry.keys.map(key => idKey(itemByKey.get(key).id)).sort(), entry.name);
    assert.equal(entry.contentType, 'application/json; charset=utf-8', entry.name);
    if (entry.status === 200) {
      assert.equal(entry.totalRecordCount, entry.keys.length, entry.name);
      assert.equal(entry.problem, null, entry.name);
    } else {
      assert.equal(entry.status, 400, entry.name);
      assert.equal(entry.totalRecordCount, null, entry.name);
      assert.deepEqual(entry.ids, [], entry.name);
      assert.deepEqual(entry.keys, [], entry.name);
      assert.equal(entry.problem.status, 400, entry.name);
      assert.equal(Object.hasOwn(entry.problem, 'traceId'), false, entry.name);
    }
  }
});

test('Is3D is raw case-sensitive substring presence, including null, nested keys, and string values', () => {
  assert.deepEqual(cases.get('is3d-true-key-presence').keys, ['threeD', 'threeDNull']);
  assert.deepEqual(cases.get('is3d-false-key-absence').keys, ['lowercase3dKey', 'notThreeD']);
  assert.deepEqual(cases.get('is3d-nested-key-substring-matches').keys, ['nested3d']);
  assert.deepEqual(cases.get('is3d-string-value-substring-matches').keys, ['stringText3d']);
  assert.deepEqual(cases.get('is3d-and-video-type-intersect').keys, ['threeD']);
});

test('VideoTypes matches exact raw VideoType or IsoType string fragments', () => {
  assert.deepEqual(cases.get('video-type-single-name').keys, ['dvd']);
  assert.deepEqual(cases.get('video-type-name-case-insensitive').keys, ['bluRay']);
  assert.deepEqual(cases.get('video-type-single-comma-union').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('video-type-isotype-also-matches').keys, ['dvd', 'isoTypeDvd']);
  assert.deepEqual(cases.get('video-type-null-value-does-not-match').keys, []);
  assert.deepEqual(cases.get('video-type-data-value-is-case-sensitive').keys, []);
  assert.deepEqual(cases.get('video-type-data-key-is-case-sensitive').keys, []);
  assert.deepEqual(cases.get('video-type-spaced-json-does-not-match').keys, []);
  assert.deepEqual(cases.get('video-type-nested-substring-matches').keys, ['nestedDvd']);
  assert.deepEqual(cases.get('video-type-json-number-does-not-match-name').keys, []);
});

test('VideoTypes binder distinguishes a single comma list from repeated occurrences', () => {
  assert.deepEqual(cases.get('binding-video-types-empty').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-comma-empty').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-whitespace').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-invalid-only').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-single-invalid-and-valid').keys, ['dvd']);
  assert.deepEqual(cases.get('binding-video-types-repeated-values').keys, ['dvd', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-repeated-first-has-comma').keys, ['bluRay', 'dvd']);
  assert.deepEqual(cases.get('binding-video-types-repeated-second-has-comma').keys, ['bluRay', 'videoFile']);
  assert.deepEqual(cases.get('binding-video-types-repeated-invalid-and-valid').keys, ['dvd']);
});

test('VideoType enum binding accepts names, undefined Int32 values, and unsigned hex two-complement forms', () => {
  assert.deepEqual(cases.get('binding-video-types-numeric-zero').keys, ['videoFile']);
  assert.deepEqual(cases.get('binding-video-types-numeric-one').keys, ['iso']);
  assert.deepEqual(cases.get('binding-video-types-numeric-two').keys, ['dvd']);
  assert.deepEqual(cases.get('binding-video-types-numeric-three').keys, ['bluRay']);
  assert.deepEqual(cases.get('binding-video-types-numeric-undefined-four').keys, ['numeric4']);
  assert.deepEqual(cases.get('binding-video-types-numeric-negative-one').keys, ['negative1']);
  assert.deepEqual(cases.get('binding-video-types-numeric-int32-max').keys, []);
  assert.deepEqual(cases.get('binding-video-types-decimal-int32-min').keys, ['numericIntMin']);
  assert.deepEqual(cases.get('binding-video-types-hex').keys, ['dvd']);
  assert.deepEqual(cases.get('binding-video-types-hash-hex').keys, ['dvd']);
  assert.deepEqual(cases.get('binding-video-types-hex-int32-sign-bit').keys, ['numericIntMin']);
  assert.deepEqual(cases.get('binding-video-types-hex-uint32-max').keys, ['negative1']);
  assert.deepEqual(cases.get('binding-video-types-positive-signed-hex').keys, ['dvd']);
  assert.deepEqual(cases.get('binding-video-types-numeric-int32-overflow').keys, ['notThreeD']);
  assert.deepEqual(cases.get('binding-video-types-numeric-negative-overflow').keys, ['notThreeD']);
  assert.deepEqual(cases.get('binding-video-types-hex-uint32-overflow').keys, ['videoFile']);
  assert.deepEqual(cases.get('binding-video-types-negative-signed-hex').keys, ['videoFile']);
});

test('folder-aware filtering uses ancestor closure and one linked hop without propagating a link match', () => {
  assert.deepEqual(cases.get('ancestor-video-type-transitive').keys, ['ancestorChild', 'ancestorRoot']);
  assert.deepEqual(cases.get('ancestor-is3d-transitive').keys, ['ancestorChild', 'ancestorRoot']);
  assert.deepEqual(cases.get('ancestor-is3d-false-excludes-folders').keys, []);
  assert.deepEqual(cases.get('linked-media-video-type-one-hop').keys, ['linkedBox']);
  assert.deepEqual(cases.get('linked-media-is3d-one-hop').keys, ['linkedBox']);
  assert.deepEqual(cases.get('linked-childtype-one-still-matches').keys, ['linkedAltTypeBox']);
  assert.deepEqual(cases.get('linked-folder-matches-own-descendant').keys, ['linkedFolder']);
  assert.deepEqual(cases.get('linked-grandparent-does-not-chain-video-type').keys, []);
  assert.deepEqual(cases.get('linked-grandparent-does-not-chain-is3d').keys, []);
  assert.deepEqual(cases.get('linked-inner-box-matches-direct-child').keys, ['linkedInnerBox']);
  assert.deepEqual(cases.get('linked-match-does-not-propagate-to-ordinary-ancestor').keys, []);
  assert.deepEqual(cases.get('linked-is3d-does-not-propagate-to-ordinary-ancestor').keys, []);
  assert.deepEqual(cases.get('folder-can-satisfy-filters-with-different-descendants').keys, ['splitDescendantFolder']);
});

test('video-property filters do not expand primary versions but do expose matching owned and alternate rows', () => {
  assert.deepEqual(cases.get('version-primary-does-not-expand-video-type').keys, []);
  assert.deepEqual(cases.get('version-alternate-matches-video-type').keys, ['versionAlternate']);
  assert.deepEqual(cases.get('version-primary-does-not-expand-is3d').keys, []);
  assert.deepEqual(cases.get('version-alternate-matches-is3d').keys, ['versionAlternate']);
  assert.deepEqual(cases.get('video-type-filter-includes-owned-item').keys, ['ownedVideo']);
  assert.deepEqual(cases.get('is3d-filter-includes-owned-item').keys, ['ownedVideo']);
  assert.deepEqual(cases.get('is3d-false-includes-owned-item').keys, ['ownedNotThreeD']);
  assert.deepEqual(cases.get('is3d-false-includes-alternate-row').keys, ['versionFalseAlternate']);
  assert.deepEqual(cases.get('invalid-video-type-does-not-enable-owned-items').keys, []);
  assert.deepEqual(cases.get('empty-is3d-does-not-enable-alternate-row').keys, []);
  assert.deepEqual(cases.get('invalid-video-type-does-not-enable-alternate-row').keys, []);
});

test('user grouping and API-key identity differ, including the legacy user-id route', () => {
  assert.deepEqual(cases.get('user-video-type-presentation-grouping').keys, ['groupFirst']);
  assert.deepEqual(cases.get('api-key-video-type-does-not-group-modern').keys, ['groupFirst', 'groupSecond']);
  assert.deepEqual(cases.get('api-key-video-type-legacy-route').keys, ['groupFirst']);
  assert.deepEqual(cases.get('user-is3d-presentation-grouping').keys, ['groupFirst']);
  assert.deepEqual(cases.get('api-key-is3d-does-not-group-modern').keys, ['groupFirst', 'groupSecond']);
});

test('Is3D scalar binding takes the first value and emits canonical validation problems', () => {
  assert.deepEqual(cases.get('binding-is3d-case-insensitive').keys, ['threeD']);
  assert.deepEqual(cases.get('binding-is3d-empty').keys, ['notThreeD', 'threeD']);
  assert.deepEqual(cases.get('binding-is3d-whitespace').keys, ['notThreeD', 'threeD']);
  assert.deepEqual(cases.get('binding-is3d-repeated-first-empty').keys, ['notThreeD', 'threeD']);
  assert.deepEqual(cases.get('binding-is3d-repeated-first-false').keys, ['notThreeD']);
  assert.deepEqual(cases.get('binding-is3d-mixed-case-repeated-key').keys, ['threeD']);
  assert.deepEqual(cases.get('binding-is3d-invalid').problem.errors,
    { is3D: ["The value '1' is not valid."] });
  assert.deepEqual(cases.get('binding-is3d-repeated-first-invalid').problem.errors,
    { is3D: ["The value '1,true' is not valid."] });
});
