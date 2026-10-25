import assert from 'node:assert/strict';
import test from 'node:test';
import { sortName } from '../../src/library/dto.js';

test('SortName pads UTF-16 digit chunks like frozen BaseItem.ModifySortChunks', () => {
  const native = [
    ['2', '0000000002'],
    ['A2B', 'a0000000002b'],
    ['𝟚', '𝟚'],
    ['A𝟚B', 'a𝟚b'],
    ['2𝟚3', '0000000002𝟚0000000003'],
    ['𝟚5', '𝟚0000000005'],
    ['5𝟚6', '0000000005𝟚0000000006'],
    ['𝟚𝟛', '𝟚𝟛'],
    ['A1𝟚2Z', 'a0000000001𝟚0000000002z'],
  ];
  for (const [name, expected] of native) assert.equal(sortName({ Name: name }), expected, name);
});
