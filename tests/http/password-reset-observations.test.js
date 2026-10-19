import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedMethods } from './fixtures/password-reset/observations.js';

test('password reset HTTP observations compare Allow as a case-sensitive method set', () => {
  assert.deepEqual(allowedMethods('DELETE, GET, POST'), allowedMethods('POST, GET, DELETE'));
  assert.notDeepEqual(allowedMethods('GET, POST'), allowedMethods('POST'));
  assert.notDeepEqual(allowedMethods('get, POST'), allowedMethods('GET, POST'));
  for (const value of ['GET, GET', 'GET,,POST', 'GET POST', 'GET, /POST', 'GET,\nPOST']) assert.throws(() => allowedMethods(value));
});
