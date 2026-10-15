import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sortItems } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';

const bytes = await readFile(new URL('./fixtures/boxset-display-order/boundary-native.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '607fe545084854c220f26478f4fa6b13188e96395542a12172f4e4253a09a26b');
const native = JSON.parse(bytes.toString('utf8'));
assert.equal(native.actualFrozenDllComparersInvoked, true);
assert.equal(native.actualLinqOrderByInvoked, true);
assert.equal(native.libraryManagerInvoked, false);
assert.equal(native.httpInvoked, false);
assert.equal(native.databaseOpened, false);
assert.deepEqual(native.output.map(row => row.name), ['DateCreated', 'DatePlayed', 'PremiereDate', 'IsFavoriteOrLiked']);
assert.equal(native.output.reduce((count, row) => count + row.pairwise.length, 0), 63);

for (const row of native.output) {
  test(`memory ${row.name}: missing dates, invalid years and liked/favorite values match frozen comparer and LINQ`, () => {
    const input = structuredClone(row.candidateItems), initial = structuredClone(input);
    const userRows = structuredClone(row.candidateUserData), userData = new Map(userRows.map(data => [idKey(data.ItemId), data]));
    const sort = (items, direction) => sortItems(items, { sortby: [row.name], sortorder: [direction] }, userData,
      item => Boolean(userData.get(idKey(item.Id))?.Played), { memory: true }).map(item => item.Id);
    assert.deepEqual(input.map(item => item.Id), row.inputOrder);
    assert.deepEqual(sort(input, 'ascending'), row.ascending);
    assert.deepEqual(sort(input, 'descending'), row.descending);
    const byId = new Map(input.map(item => [item.Id, item]));
    for (const pair of row.pairwise) for (const direction of ['ascending', 'descending']) {
      const items = [byId.get(pair.left), byId.get(pair.right)];
      const sign = direction === 'ascending' ? pair.compare : -pair.compare;
      assert.deepEqual(sort(items, direction), sign > 0 ? [pair.right, pair.left] : [pair.left, pair.right],
        `${direction}: ${pair.left}/${pair.right}, frozen comparison=${pair.compare}`);
    }
    assert.deepEqual(input, initial);
    assert.deepEqual([...userData.values()], userRows);
  });
}
