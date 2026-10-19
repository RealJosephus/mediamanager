import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUserBody } from '../../src/http/user-binding.js';
import { BindingError } from '../../src/http/binding.js';

function bind(kind, text) {
  const body = JSON.parse(text);
  Object.defineProperty(body, Symbol.for('mediamanager.jsonSource'), { value: text });
  return validateUserBody(kind, body);
}

test('user JSON binding preserves native raw string coercion, enum combinations and nullable scalars', () => {
  assert.deepEqual(bind('create', '{"Name":1e3,"Password":true}'), { Name: '1e3', Password: 'true' });
  assert.deepEqual(bind('configuration', '{"SubtitleMode":"Always, OnlyForced","OrderedViews":[null]}'),
    { SubtitleMode: 3, OrderedViews: ['00000000000000000000000000000000'] });
  assert.equal(bind('configuration', '{"SubtitleMode":" 2 "}').SubtitleMode, 2);
  assert.equal(bind('configuration', '{"SubtitleMode":99}').SubtitleMode, 99);
  assert.equal(bind('configuration', '{"OrderedViews":["{0x01234567,0x0123,0x0123,{0x01,0x23,0x01,0x23,0x45,0x67,0x89,0xab}}"]}').OrderedViews[0],
    '01234567-0123-0123-0123-0123456789AB');
  assert.deepEqual(bind('password', '{"currentpw":123,"newpw":false}'), { CurrentPw: '123', NewPw: 'false' });
  assert.equal(bind('update', '{"Policy":null,"HasPassword":""}').HasPassword, null);
});

test('user JSON binding rejects invalid primitive tokens and validates the default nested policy', () => {
  for (const text of ['{"RememberAudioSelections":0}', '{"RememberAudioSelections":"true"}', '{"SubtitleMode":null}', '{"SubtitleMode":1.0}', '{"OrderedViews":null}']) {
    assert.throws(() => bind('configuration', text), BindingError);
  }
  assert.throws(() => bind('create', '{"Name":{}}'), BindingError);
  assert.throws(() => bind('update', '{"Name":"NewName","Configuration":{}}'), error => {
    assert.deepEqual(error.errors, {
      'Policy.PasswordResetProviderId': ['The PasswordResetProviderId field is required.'],
      'Policy.AuthenticationProviderId': ['The AuthenticationProviderId field is required.']
    });
    return true;
  });
});
