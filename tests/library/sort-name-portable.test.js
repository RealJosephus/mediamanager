import assert from 'node:assert/strict';
import test from 'node:test';
import { sortName } from '../../src/library/dto.js';

// Pure JavaScript romanization is required; exact ICU4N output is not.
// Keep the frozen outputs alongside the portable ones for differential review.
const cases = [
  ['Alpha 中文', 'alpha zhong wen', 'alpha zhong wen'],
  ['東京', 'dong jing', 'dong jing'],
  ['Καλημέρα', 'kalemera', 'kalemera'],
  ['Привет', 'privet', 'privet'],
  ['العربية', 'alʿrbyt', 'alʿrbyt'],
  ['हिन्दी', 'hindii', 'hindi'],
  ['ภาษาไทย', 'phaasaaaithy', 'phasa thiy'],
  ['ｶﾞ', 'ga', 'ga'],
  ['ｶﾟ', 'ka', 'ka'],
  ['ﾊﾟ', 'pa', 'pa'],
  ['ｿﾞ', 'zo', 'zo'],
  ['ｳﾞ', 'vu', 'vu'],
  ['￢', '¬', '¬'],
  ['中文，東京！', 'zhong wen dong jing', 'zhong wen dong jing'],
];

test('portable SortName romanizes scripts with explicit ICU differences', () => {
  for (const [name, expected] of cases) {
    assert.equal(sortName({ Name: name }), expected, name);
  }
  assert.deepEqual(cases.filter(([, portable, native]) => portable !== native).map(([name]) => name),
    ['हिन्दी', 'ภาษาไทย']);
  assert.equal(sortName({ Name: '张国荣' }), 'zhang guo rong');
  assert.equal(sortName({ Name: '가나다' }), 'ganada');
  assert.equal(sortName({ Name: 'Crème brûlée' }), 'creme brulee');
  assert.equal(sortName({ Name: '👩🏽‍💻' }), '👩🏽‍💻');
  assert.equal(sortName({ Name: '2𝟚3' }), '0000000002𝟚0000000003');
  assert.equal(sortName({ Name: '𠮷' }), '𠮷', 'unmapped letters must not disappear');
  assert.equal(sortName({ Name: '中𠮷文' }), 'zhong 𠮷 wen', 'unknown letters within a supported run must not disappear');
  assert.equal(sortName({ Name: '中𠀀文' }), 'zhong he wen', 'the text table includes supplementary Han readings');
  assert.equal(sortName({ Name: 'ガ' }), sortName({ Name: 'ｶﾞ' }));
  assert.equal(sortName({ Name: 'ガ'.normalize('NFD') }), sortName({ Name: 'ガ' }));
});

test('portable SortName keeps forced names and Person rules without a stored-key fallback', () => {
  assert.equal(sortName({ Name: 'Should be ignored', ForcedSortName: '東京', SortName: 'stale' }), 'dong jing');
  assert.equal(sortName({ Name: 'Alpha 中文', SortName: 'stale' }), 'alpha zhong wen');
  assert.equal(sortName({ Type: 'Person', Name: ' 中文 ' }), '中文 ');
  assert.equal(sortName({ Type: 'Person', Name: 'name', ForcedSortName: ' 東京 ' }), '東京 ');
  assert.equal(sortName({ Name: 'The Movie-12' }), 'movie0000000012');
});
