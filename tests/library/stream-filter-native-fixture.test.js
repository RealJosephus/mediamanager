import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inputUrl = validationFileUrl('./fixtures/stream-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/stream-filters/native.json', import.meta.url);
const inputBytes = await readFile(inputUrl);
const input = JSON.parse(inputBytes);
const native = JSON.parse(await readFile(nativeUrl));
const cases = new Map(native.cases.map(entry => [entry.name, entry]));
const contract = (name, endpoint = 'items') => {
  const entry = cases.get(name)?.contracts.find(candidate => candidate.endpoint === endpoint);
  assert.ok(entry, `${name}:${endpoint}`);
  return entry;
};

test('frozen stream-filter fixture is complete, internally linked, and input-hash pinned', () => {
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.frozenJellyfin, true);
  assert.equal(native.sourceEvidence, '.agent-docs/evidence/continuation-20260928/stream-filter-native-v4/native-contract.json');
  assert.deepEqual(native.endpoints, ['/Items', '/Users/{userId}/Items']);
  assert.equal(native.fixtureInputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.cases.length, input.cases.length);
  assert.equal(cases.size, input.cases.length);
  assert.equal(native.cases.reduce((total, entry) => total + entry.contracts.length, 0), 126);
  const itemKeys = new Set(input.items.map(item => item.key));
  for (const entry of native.cases) {
    const source = input.cases.find(candidate => candidate.name === entry.name);
    assert.ok(source, entry.name);
    assert.equal(entry.query, source.query, entry.name);
    assert.deepEqual(entry.scope, source.scope, entry.name);
    assert.equal(entry.parentKey, source.parentKey, entry.name);
    assert.equal(entry.auth, source.auth ?? 'user', entry.name);
    assert.deepEqual(entry.endpoints, source.endpoints ?? ['items', 'legacy'], entry.name);
    assert.deepEqual(entry.contracts.map(candidate => candidate.endpoint), entry.endpoints, entry.name);
    assert.ok(entry.scope.every(key => itemKeys.has(key)), entry.name);
    for (const result of entry.contracts) {
      assert.ok(result.keys.every(key => entry.scope.includes(key)), `${entry.name}:${result.endpoint}`);
      assert.equal(result.contentType, 'application/json; charset=utf-8', `${entry.name}:${result.endpoint}`);
      if (result.status === 200) {
        assert.ok(result.totalRecordCount >= result.keys.length, `${entry.name}:${result.endpoint}`);
        assert.equal(result.problem, null, `${entry.name}:${result.endpoint}`);
      } else {
        assert.equal(result.status, 400, `${entry.name}:${result.endpoint}`);
        assert.equal(result.totalRecordCount, null, `${entry.name}:${result.endpoint}`);
        assert.equal(result.problem.status, 400, `${entry.name}:${result.endpoint}`);
        assert.equal(Object.hasOwn(result.problem, 'traceId'), false, `${entry.name}:${result.endpoint}`);
      }
    }
  }
});

test('frozen HasSubtitles binding and controller combination rules are exact on both routes', () => {
  assert.deepEqual(contract('has-subtitles-true').keys, ['subEng']);
  assert.deepEqual(contract('has-subtitles-false').keys, ['audioEng', 'none']);
  assert.deepEqual(contract('has-subtitles-empty').keys, ['none', 'subEng']);
  assert.deepEqual(contract('has-subtitles-whitespace').keys, ['none', 'subEng']);
  assert.deepEqual(contract('has-subtitles-case-insensitive').keys, ['subEng']);
  assert.deepEqual(contract('has-subtitles-repeated-first-true').keys, ['subEng']);
  assert.deepEqual(contract('has-subtitles-repeated-first-empty').keys, ['none', 'subEng']);
  assert.deepEqual(contract('controller-combination-true-prefers-language').keys, ['subFre']);
  assert.deepEqual(contract('controller-combination-true-prefers-language', 'legacy').keys, ['subEng', 'subFre']);
  assert.deepEqual(contract('controller-combination-false-prefers-absence').keys, ['audioEng', 'none']);
  assert.deepEqual(contract('controller-combination-empty-applies-language').keys, ['subFre']);
  assert.deepEqual(contract('controller-combination-empty-applies-language', 'legacy').keys, ['none', 'subEng', 'subFre']);
});

test('frozen language binders split one occurrence but not repeated occurrences, trim, and retain repeated empties', () => {
  assert.deepEqual(contract('subtitle-single-comma').keys, ['subEng', 'subFre']);
  assert.deepEqual(contract('subtitle-repeated-does-not-resplit').keys, ['subSpa']);
  assert.deepEqual(contract('subtitle-repeated-simple').keys, ['subEng', 'subFre']);
  assert.deepEqual(contract('subtitle-whitespace-trimmed').keys, ['subEng']);
  assert.deepEqual(contract('subtitle-empty-single-no-filter').keys, ['none', 'subEng']);
  assert.deepEqual(contract('subtitle-repeated-empty-is-value').keys, ['subEng', 'subUndEmpty']);
  assert.deepEqual(contract('audio-single-comma').keys, ['audioEng', 'audioFre']);
  assert.deepEqual(contract('audio-repeated-does-not-resplit').keys, ['audioUndNull']);
  assert.deepEqual(contract('audio-repeated-simple').keys, ['audioEng', 'audioFre']);
  assert.deepEqual(contract('audio-whitespace-trimmed').keys, ['audioEng']);
  assert.deepEqual(contract('audio-empty-single-no-filter').keys, ['audioEng', 'none']);
  assert.deepEqual(contract('audio-repeated-empty-is-value').keys, ['audioEng', 'audioUndEmpty']);
});

test('frozen language matching is case-sensitive while und matches null and empty language', () => {
  assert.deepEqual(contract('subtitle-language-case-sensitive').keys, ['subUpperEng']);
  assert.deepEqual(contract('audio-language-case-sensitive').keys, []);
  assert.deepEqual(contract('subtitle-und-null-or-empty').keys, ['subUndEmpty', 'subUndNull']);
  assert.deepEqual(contract('subtitle-und-and-eng').keys, ['subEng', 'subUndEmpty', 'subUndNull']);
  assert.deepEqual(contract('audio-und-null-or-empty').keys, ['audioUndEmpty', 'audioUndNull']);
  assert.deepEqual(contract('audio-und-and-eng').keys, ['audioEng', 'audioUndEmpty', 'audioUndNull']);
  assert.deepEqual(contract('subtitle-audio-intersection').keys, ['subEngAudioFre']);
});

test('legacy Items ignores both language parameters while retaining HasSubtitles', () => {
  assert.deepEqual(contract('subtitle-single').keys, ['subEng']);
  assert.deepEqual(contract('subtitle-single', 'legacy').keys, ['none', 'subEng', 'subFre']);
  assert.deepEqual(contract('audio-single').keys, ['audioEng']);
  assert.deepEqual(contract('audio-single', 'legacy').keys, ['audioEng', 'audioFre', 'none']);
  assert.deepEqual(contract('alternate-language-mismatch').keys, []);
  assert.deepEqual(contract('alternate-language-mismatch', 'legacy').keys, ['versionPrimary']);
  assert.deepEqual(contract('has-subtitles-true', 'legacy').keys, ['subEng']);
});

test('frozen stream filters include alternate versions and owned items without exposing the alternate', () => {
  assert.deepEqual(contract('alternate-has-subtitles').keys, ['versionPrimary']);
  assert.deepEqual(contract('alternate-subtitle-language').keys, ['versionPrimary']);
  assert.deepEqual(contract('alternate-audio-language').keys, ['versionPrimary']);
  assert.deepEqual(contract('owned-has-subtitles-included').keys, ['ownerStreams']);
  assert.deepEqual(contract('owned-subtitle-language-included-modern').keys, ['ownerStreams']);
  assert.deepEqual(contract('owned-audio-language-included-modern').keys, ['ownerStreams']);
  assert.deepEqual(contract('owned-subtitle-language-included-modern', 'legacy').keys, []);
  assert.deepEqual(contract('owned-empty-filter-hidden').keys, []);
});

test('frozen folder matching crosses ancestor closure, recursive container links, and the linked-parent seam', () => {
  assert.deepEqual(contract('ancestor-closure-has-subtitles').keys, ['ancestorTop']);
  assert.deepEqual(contract('ancestor-closure-subtitle-language').keys, ['ancestorTop']);
  assert.deepEqual(contract('ancestor-closure-audio-language').keys, ['ancestorTop']);
  assert.deepEqual(contract('ancestor-closure-has-no-subtitles').keys, []);
  assert.deepEqual(contract('empty-folder-has-no-subtitles').keys, ['noSubFolder']);
  assert.deepEqual(contract('recursive-linked-folders-has-subtitles').keys, ['linkedBox3']);
  assert.deepEqual(contract('recursive-linked-folders-subtitle-language').keys, ['linkedBox3']);
  assert.deepEqual(contract('recursive-linked-folders-audio-language').keys, ['linkedBox3']);
  assert.deepEqual(contract('recursive-linked-folders-negative').keys, []);
  assert.deepEqual(contract('local-alternate-link-type-excluded').keys, []);
  assert.deepEqual(contract('linked-alternate-link-type-excluded').keys, []);
  assert.deepEqual(contract('linked-parent-ancestor').keys, ['seamLinkedAncestor']);
  assert.deepEqual(contract('linked-parent-root-seam').keys, ['seamTop']);
  assert.deepEqual(contract('linked-parent-root-seam-subtitle-language').keys, ['seamTop']);
  assert.deepEqual(contract('linked-parent-root-seam-audio-language').keys, ['seamTop']);
});

test('frozen user grouping precedes count and paging while API-key queries remain ungrouped', () => {
  assert.deepEqual(contract('user-presentation-grouping').keys, ['groupFirst', 'groupThird']);
  assert.deepEqual(contract('user-grouping-before-count-and-pagination').keys, ['groupThird']);
  assert.equal(contract('user-grouping-before-count-and-pagination').totalRecordCount, 2);
  assert.deepEqual(contract('api-key-does-not-group').keys, ['groupFirst', 'groupSecond', 'groupThird']);
  assert.deepEqual(contract('api-key-language-does-not-group').keys, ['groupFirst', 'groupSecond', 'groupThird']);
  assert.deepEqual(contract('api-key-route-user-semantics').keys, ['groupFirst', 'groupSecond', 'groupThird']);
  assert.deepEqual(contract('api-key-route-user-semantics', 'legacy').keys, ['groupFirst', 'groupThird']);
  assert.deepEqual(contract('api-key-subtitle-language-legacy-ignored').keys, ['groupFirst', 'groupSecond']);
  assert.deepEqual(contract('api-key-subtitle-language-legacy-ignored', 'legacy').keys, ['groupFirst', 'none']);
  assert.deepEqual(contract('api-key-audio-language-legacy-ignored').keys, ['audioEng']);
  assert.deepEqual(contract('api-key-audio-language-legacy-ignored', 'legacy').keys, ['audioEng', 'audioFre', 'none']);
});

test('frozen validation problems retain canonical names and attempted repeated values', () => {
  const expectedBase = {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400
  };
  for (const endpoint of ['items', 'legacy']) {
    assert.deepEqual(contract('has-subtitles-invalid', endpoint).problem, {
      ...expectedBase,
      errors: { hasSubtitles: ["The value '1' is not valid."] }
    });
    assert.deepEqual(contract('has-subtitles-repeated-first-invalid', endpoint).problem, {
      ...expectedBase,
      errors: { hasSubtitles: ["The value '1,true' is not valid."] }
    });
  }
});
