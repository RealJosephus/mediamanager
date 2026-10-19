import assert from 'node:assert/strict';
import test from 'node:test';
import { sortName } from '../../src/library/dto.js';
import data from '../../src/library/resources/sort-name-data.json' with { type: 'json' };
import sources from '../../src/library/resources/sort-name-sources.json' with { type: 'json' };
import fixture from './fixtures/sort-name-unicode.json' with { type: 'json' };

test('portable SortName matches frozen whole-title Unicode contracts', () => {
  assert.equal(fixture.cases.length, 203);
  for (const { input, expected } of fixture.cases) {
    assert.equal(sortName({ Name: input }), expected, JSON.stringify(input));
    assert.equal(sortName({ Name: 'ignored', ForcedSortName: input, SortName: 'stored' }), expected, `forced ${JSON.stringify(input)}`);
  }
});

test('remaining portable phonetic differences are explicit, not claimed as native matches', () => {
  assert.equal(fixture.knownDifferences.length, 6);
  for (const { input, candidate, native } of fixture.knownDifferences) {
    assert.notEqual(candidate, native, `${input}: a resolved difference must leave this list`);
    assert.equal(sortName({ Name: input }), candidate, input);
  }
});

test('portable Unicode resources contain ordered, unique, pinned text mappings', () => {
  assert.equal(data.unicodeVersion, '10.0.0');
  assert.equal(data.han.length, 412);
  const hanCharacters = data.han.flatMap(([, characters]) => [...characters]);
  assert.equal(hanCharacters.length, 41327);
  assert.equal(new Set(hanCharacters).size, hanCharacters.length);
  for (const [reading] of data.han) assert.match(reading, /^[a-z]+$/u);
  for (const ranges of [data.categories, data.scripts, data.ideographic]) {
    let previous = -1;
    for (const [start, end] of ranges) {
      assert.ok(start > previous && end >= start && end < 0x110000);
      previous = end;
    }
  }
  for (const { url, sha256 } of sources.sources) {
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/unicode-org\//u);
    assert.match(sha256, /^[a-f\d]{64}$/u);
  }
});

test('SortName keeps its ASCII gate and configured preprocessing order', () => {
  assert.equal(sortName({ Name: 'Hello!' }), 'hello!');
  assert.equal(sortName({ Name: 'é!' }), 'e!');
  assert.equal(sortName({ Name: 'Hello！' }), 'hello');
  assert.equal(sortName({ Name: '中，文' }), 'zhong wen');
  assert.equal(sortName({ Name: '中，文' }, { configuration: { SortRemoveCharacters: ['，'] } }), 'zhong wen');
  assert.equal(sortName({ Name: 'A，B' }, { configuration: { SortReplaceCharacters: ['，'] } }), 'a b');
  assert.equal(sortName({ Name: '１' }), '0000000001');
  assert.equal(sortName({ Name: '𝟚' }), '𝟚');
  assert.equal(sortName({ Name: '⑩' }), '⑩');
});

test('long mixed-script names retain all supported and unknown letters', () => {
  const input = '中a𠮷'.repeat(2048);
  assert.equal(sortName({ Name: input }), 'zhonga 𠮷 '.repeat(2048).trimEnd());
});
