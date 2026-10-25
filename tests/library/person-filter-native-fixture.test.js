import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inputUrl = validationFileUrl('./fixtures/person-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/person-filters/native.json', import.meta.url);
const inputBytes = await readFile(inputUrl);
const input = JSON.parse(inputBytes);
const native = JSON.parse(await readFile(nativeUrl));
const cases = new Map(native.cases.map(entry => [entry.name, entry]));
const itemByKey = new Map(input.items.map(item => [item.key, item]));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

test('frozen person-filter fixture is complete, endpoint-pinned, and linked to its exact input', () => {
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.frozenJellyfin, true);
  assert.equal(native.sourceEvidence, '.test-input/evidence/person-sortname-memory-default-frozen-v1/native-contract.json');
  assert.deepEqual(native.endpoints, ['/Items', '/Users/{userId}/Items']);
  assert.equal(native.fixtureInputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.cases.length, 62);
  assert.equal(native.cases.length, input.cases.length);
  assert.equal(cases.size, input.cases.length);
  // Explicit overrides agree with the recorder's raw lower-case input.
  for (const item of input.items) if (Object.hasOwn(item, 'cleanName')) {
    assert.equal(item.cleanName, item.name.toLowerCase(), item.key + ': native CleanName input');
  }

  for (const entry of native.cases) {
    const source = input.cases.find(candidate => candidate.name === entry.name);
    assert.ok(source, entry.name);
    assert.equal(entry.query, source.query, entry.name);
    assert.deepEqual(entry.scope, source.scope, entry.name);
    assert.equal(entry.auth, source.auth ?? 'user', entry.name);
    assert.deepEqual(entry.endpoints, source.endpoints ?? ['items', 'legacy'], entry.name);
    if (entry.name.startsWith('person-sortname-')) {
      assert.equal(entry.sortBy, source.sortBy, entry.name);
      assert.equal(entry.omitSortBy, source.omitSortBy, entry.name);
      assert.equal(entry.fields, source.fields, entry.name);
    }
    const expectedStatus = source.expectedStatus ?? 200;
    assert.equal(entry.status, expectedStatus, entry.name);
    assert.equal(entry.contentType, expectedStatus === 200 ? 'application/json; charset=utf-8' : 'text/plain', entry.name);
    assert.equal(entry.problem, null, entry.name);
    if (expectedStatus !== 200) {
      assert.equal(entry.totalRecordCount, null, entry.name);
      assert.deepEqual(entry.keys, [], entry.name);
      assert.deepEqual(entry.ids, [], entry.name);
      assert.deepEqual(entry.orderedKeys, [], entry.name);
      assert.deepEqual(entry.sortNames, [], entry.name);
      assert.equal(entry.errorText, 'Error processing request.', entry.name);
      continue;
    }
    const eligible = source.parentKey
      ? input.items.filter(item => item.parentId === itemByKey.get(source.parentKey).id).map(item => item.key)
      : entry.scope;
    assert.ok(entry.keys.every(key => eligible.includes(key)), entry.name);
    assert.deepEqual(entry.ids, entry.keys.map(key => idKey(itemByKey.get(key).id)).sort(), entry.name);
    const expectedCount = entry.name === 'user-group-count-before-page' ? 2
      : entry.name.startsWith('person-sortname-') ? 6 : entry.keys.length;
    assert.equal(entry.totalRecordCount, expectedCount, entry.name);
  }
});

test('Person SortName HTTP fixture pins repository and memory ordering, paging, and DTO values', () => {
  const order = ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'];
  const page = order.slice(1, 4);
  for (const mode of ['repository', 'memory']) {
    for (const [suffix, expected] of [['full', order], ['page', page]]) {
      const entry = cases.get(`person-sortname-${mode}-${suffix}`);
      assert.deepEqual(entry.orderedKeys, expected);
      assert.deepEqual(entry.sortNames, expected.map(key => ({ key, value: itemByKey.get(key).sortName })));
      assert.equal(entry.totalRecordCount, 6);
      assert.equal(entry.fields, 'SortName');
      assert.deepEqual(entry.endpoints, ['items', 'legacy']);
    }
  }
});

test('Person sorting variants pin Name, descending, Ids fallback, and excess directions', () => {
  const full = ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'];
  const reversed = [...full].reverse();
  const nameOrder = ['sortTail', 'sortA2', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'];
  for (const mode of ['repository', 'memory']) {
    for (const [suffix, order] of [['descending', reversed], ['name', nameOrder]]) {
      const entry = cases.get(`person-sortname-${mode}-${suffix}`);
      assert.deepEqual(entry.orderedKeys, order);
      assert.deepEqual(entry.sortNames, order.map(key => ({ key, value: itemByKey.get(key).sortName })));
      assert.equal(entry.totalRecordCount, 6);
      assert.deepEqual(entry.endpoints, ['items', 'legacy']);
    }
  }
  assert.equal(cases.get('person-sortname-repository-name').sortBy, 'Name');
  assert.equal(cases.get('person-sortname-memory-name').sortBy, 'Name');
  const requested = ['sortThe2', 'sortA2', 'sortEmile', 'sortChinese', 'sortMath2', 'sortTail'];
  assert.deepEqual(cases.get('person-sortname-repository-no-order').orderedKeys, requested);
  assert.deepEqual(cases.get('person-sortname-repository-no-order-page').orderedKeys,
    ['sortThe2', 'sortEmile', 'sortTail']);
  for (const suffix of ['no-order', 'no-order-page']) {
    assert.equal(cases.get(`person-sortname-repository-${suffix}`).omitSortBy, true);
    assert.equal(cases.get(`person-sortname-repository-${suffix}`).totalRecordCount, 6);
  }
  assert.deepEqual(cases.get('person-sortname-memory-no-order').orderedKeys, full);
  assert.deepEqual(cases.get('person-sortname-memory-no-order-page').orderedKeys, full.slice(1, 4));
  for (const suffix of ['no-order', 'no-order-page']) {
    const entry = cases.get(`person-sortname-memory-${suffix}`);
    assert.equal(entry.omitSortBy, true);
    assert.equal(entry.totalRecordCount, 6);
    assert.deepEqual(entry.sortNames,
      entry.orderedKeys.map(key => ({ key, value: itemByKey.get(key).sortName })));
  }
  for (const mode of ['repository', 'memory']) {
    const entry = cases.get(`person-sortname-${mode}-excess-directions`);
    assert.equal(entry.status, 400);
    assert.equal(entry.contentType, 'text/plain');
    assert.equal(entry.errorText, 'Error processing request.');
  }
});

test('Person is an exact case-sensitive name predicate with first-value scalar binding', () => {
  assert.deepEqual(cases.get('person-exact-name').keys, ['aliceActor']);
  assert.deepEqual(cases.get('person-query-key-case-insensitive').keys, ['aliceActor']);
  assert.deepEqual(cases.get('person-value-case-sensitive').keys, ['lowercaseAlice']);
  assert.deepEqual(cases.get('person-unicode-and-space').keys, ['unicodeCredit']);
  assert.deepEqual(cases.get('person-empty-no-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-whitespace-no-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-repeated-first-value').keys, ['aliceActor', 'aliceBob']);
  assert.deepEqual(cases.get('person-repeated-first-empty').keys, ['aliceActor', 'noCredit']);
});

test('PersonIds bridges BaseItem names to people and does not consume People ids directly', () => {
  assert.deepEqual(cases.get('person-id-name-bridge').keys, ['aliceActor', 'aliceDirector']);
  assert.deepEqual(cases.get('person-id-is-not-people-id').keys, []);
  assert.deepEqual(cases.get('person-id-non-person-same-name-bridge').keys, ['aliceActor', 'aliceDirector']);
  assert.deepEqual(cases.get('person-id-missing-selector-matches-nothing').keys, []);
});

test('PersonIds collection binding drops invalid values and distinguishes comma lists from occurrences', () => {
  assert.deepEqual(cases.get('person-ids-single-comma-or').keys, ['aliceActor', 'bobDirector']);
  assert.deepEqual(cases.get('person-ids-invalid-only-drops-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-ids-single-invalid-and-valid').keys, ['aliceActor']);
  assert.deepEqual(cases.get('person-ids-repeated-values').keys, ['aliceActor', 'bobDirector']);
  assert.deepEqual(cases.get('person-ids-repeated-occurrence-with-comma').keys, ['bobDirector']);
  assert.deepEqual(cases.get('person-ids-empty-drops-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-ids-whitespace-drops-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-ids-query-key-case-insensitive').keys, ['aliceActor']);
});

test('PersonIds HTTP binding exposes P/X Guid parsing only where occurrence splitting permits it', () => {
  assert.deepEqual(cases.get('person-ids-p-format').keys, ['aliceActor']);
  assert.deepEqual(cases.get('person-ids-p-format-invalid-neighbor-drops-filter').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-ids-x-format').keys, ['aliceActor', 'bobDirector']);
  assert.deepEqual(cases.get('person-ids-x-format-repeated-occurrence').keys, ['aliceActor', 'bobDirector']);
  assert.deepEqual(cases.get('person-ids-x-format-invalid-neighbor-drops-filter').keys, ['aliceActor', 'noCredit']);
});

test('PersonTypes is a raw exact string restriction only when Person or PersonIds is active', () => {
  assert.deepEqual(cases.get('person-types-alone-no-sql-predicate').keys, ['aliceActor', 'noCredit']);
  assert.deepEqual(cases.get('person-with-actor-type').keys, ['aliceActor', 'aliceBob']);
  assert.deepEqual(cases.get('person-with-director-type').keys, ['aliceDirector']);
  assert.deepEqual(cases.get('person-type-value-case-sensitive').keys, []);
  assert.deepEqual(cases.get('person-with-arbitrary-numeric-type').keys, ['numericType']);
  assert.deepEqual(cases.get('person-types-single-comma-union').keys, ['aliceActor', 'aliceDirector']);
  assert.deepEqual(cases.get('person-types-repeated-values').keys, ['aliceActor', 'aliceDirector']);
  assert.deepEqual(cases.get('person-types-repeated-comma-is-literal').keys, ['aliceWriter', 'compositeType']);
  assert.deepEqual(cases.get('person-types-empty-does-not-restrict').keys, ['aliceActor', 'aliceDirector']);
  assert.deepEqual(cases.get('person-types-whitespace-restricts-empty-string').keys, []);
  assert.deepEqual(cases.get('person-types-query-key-case-insensitive').keys, ['aliceActor']);
});

test('Person and PersonIds are independent AND predicates and PersonTypes restricts both', () => {
  assert.deepEqual(cases.get('person-ids-with-type').keys, ['aliceDirector']);
  assert.deepEqual(cases.get('person-and-person-id-use-independent-and').keys, ['aliceBob']);
  assert.deepEqual(cases.get('person-and-person-id-types-apply-to-both').keys, []);
});

test('person predicates do not propagate through ancestors, linked parents, versions, or owners', () => {
  assert.deepEqual(cases.get('person-filter-does-not-propagate-to-ancestors').keys, ['ancestorChild']);
  assert.deepEqual(cases.get('person-filter-does-not-propagate-to-linked-parent').keys, ['linkedChild']);
  assert.deepEqual(cases.get('person-filter-does-not-expand-alternate-to-primary').keys, []);
  assert.deepEqual(cases.get('person-filter-does-not-include-owned-item').keys, []);
});

test('user identity controls grouping while total count remains pre-page', () => {
  assert.deepEqual(cases.get('user-person-presentation-grouping').keys, ['groupFirst']);
  assert.deepEqual(cases.get('user-group-count-before-page').keys, ['aliceActor']);
  assert.equal(cases.get('user-group-count-before-page').totalRecordCount, 2);
  assert.deepEqual(cases.get('api-key-person-does-not-group-modern').keys, ['groupFirst', 'groupSecond']);
  assert.deepEqual(cases.get('api-key-person-modern-with-user-id').keys, ['groupFirst']);
  assert.deepEqual(cases.get('api-key-person-legacy-route').keys, ['groupFirst']);
});
