import assert from 'node:assert/strict';
import test from 'node:test';
import { sortName } from '../../src/library/dto.js';

test('Person SortName uses native leading-only CLR trim without alphanumeric rules', () => {
  const native = [
    ['The 2', 'The 2'],
    ['  The 2  ', 'The 2  '],
    [' \u0085Name \u0085', 'Name \u0085'],
    ['A-2', 'A-2'],
    ['Émile', 'Émile'],
    ['中文', '中文'],
    ['\uFEFFBob', '\uFEFFBob'],
    ['  𝟚  ', '𝟚  '],
    ['', ''],
    [null, null],
  ];
  for (const [name, expected] of native) {
    assert.equal(sortName({ Type: 'MediaBrowser.Controller.Entities.Person', Name: name }), expected, String(name));
  }
  assert.equal(sortName({ Type: 'Person', Name: 'Ignored', ForcedSortName: '  The 2  ' }), 'The 2  ');
});
